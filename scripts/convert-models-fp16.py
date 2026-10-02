#!/usr/bin/env python3
"""
Convert the AI cutout models to fp16 (the files the app ships).

    python3.11 -m venv .venv-models
    .venv-models/bin/pip install -r scripts/requirements-models.txt
    .venv-models/bin/python scripts/convert-models-fp16.py --src SRC_DIR --out OUT_DIR

For each model below, the upstream fp32 ONNX file is taken from SRC_DIR
(downloaded there from its pinned Hugging Face commit when missing) and
checked against its pinned size and SHA-256. The script then

- keeps only the graph output the segmentation worker reads (the general
  IS-Net export also returns 11 side outputs the app never fetches) and
  drops the nodes and weights that only fed the others;
- for models marked `fix_inputs`, `isolate_outputs`, `rename_dim_params`,
  `square_pows`, `double_to_float` or `cast_output_float32`, applies that step (see the
  model list and the functions);
- for models marked `pad_conv_channels` (MODNet, RVM), zero-pads the input
  channels of every Conv whose channel count is not a multiple of 4 (see
  pad_conv_input_channels: onnxruntime-web's WebGPU backend computes those
  Convs wrong; the padded graph computes exactly the same values);
- converts weights and activations to float16 with onnxconverter-common,
  `keep_io_types=True`: the input and the output stay float32, so the
  worker feeds and reads exactly the same tensors as with the fp32 file.
  The converter's default op block list stays in force (Resize, for one,
  keeps running in float32 between Cast nodes);
- records where the file comes from in the model's metadata, validates it
  with the ONNX checker, and prints its size and SHA-256.

With the versions pinned in scripts/requirements-models.txt the output is
byte-for-byte reproducible (whatever PYTHONHASHSEED is), so the printed
hashes must equal the pins in src/features/ai-cutout/model-registry.js
(the files are published as assets of the `models-v1` GitHub Release,
which `npm run models:fetch` downloads). tests/unit/ai-cutout/model-config.test.js checks that the
upstream pins and asset names below match the registry.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import urllib.request
import warnings
from pathlib import Path

import numpy as np
import onnx
import onnxconverter_common
from onnx import helper, numpy_helper
from onnxconverter_common import float16

MODELS = [
    {
        "id": "anime",
        "asset": "isnetis-fp16.onnx",
        "fp32_file": "isnetis.onnx",
        "upstream_url": "https://huggingface.co/skytnt/anime-seg/resolve/"
        "493cb60893f47441b26ec4fb9a306bce9e342982/isnetis.onnx",
        "upstream_bytes": 176_069_933,
        "upstream_sha256": "f15622d853e8260172812b657053460e20806f04b9e05147d49af7bed31a6e99",
        "keep_outputs": ["mask"],
    },
    {
        "id": "general",
        "asset": "isnet-general-fp16.onnx",
        "fp32_file": "isnet-general-use.onnx",
        "upstream_url": "https://huggingface.co/BritishWerewolf/IS-Net/resolve/"
        "9783722d9f964c0286a411e7e8e6fede947d5a53/onnx/model.onnx",
        "upstream_bytes": 178_648_008,
        "upstream_sha256": "60920e99c45464f2ba57bee2ad08c919a52bbf852739e96947fbb4358c0d964a",
        "keep_outputs": ["output_image"],
    },
    {
        "id": "portrait",
        "asset": "modnet-portrait-fp16.onnx",
        "fp32_file": "modnet.onnx",
        "upstream_url": "https://huggingface.co/Xenova/modnet/resolve/"
        "fa2fa546052fba4c08921230a26cc69a333fca12/onnx/model.onnx",
        "upstream_bytes": 25_888_640,
        "upstream_sha256": "07c308cf0fc7e6e8b2065a12ed7fc07e1de8febb7dc7839d7b7f15dd66584df9",
        "keep_outputs": ["output"],
        "pad_conv_channels": True,
    },
    {
        "id": "ben2",
        "asset": "ben2-base-fp16.onnx",
        "fp32_file": "BEN2_Base.onnx",
        "upstream_url": "https://huggingface.co/PramaLLC/BEN2/resolve/"
        "e48a20765fb421d19dcdb0bf3cc61e802ca5ec8f/BEN2_Base.onnx",
        "upstream_bytes": 222_932_053,
        "upstream_sha256": "22cea62108ff53b7ccc20f7a008bf30494228d84b1687f29ecbe76936a998101",
        "keep_outputs": ["17728"],
        # Upstream already ships it in mixed precision (float16 weights, a
        # float16 output): no conversion, only a float32 output named `mask`
        "fp16": False,
        "cast_output_float32": "mask",
        "square_pows": True,
        "double_to_float": True,
    },
    {
        "id": "video-person",
        "asset": "rvm-resnet50-fp16.onnx",
        "fp32_file": "rvm_resnet50_fp32.onnx",
        "upstream_url": "https://github.com/PeterL1n/RobustVideoMatting/releases/download/"
        "v1.0.0/rvm_resnet50_fp32.onnx",
        "upstream_bytes": 107_479_165,
        "upstream_sha256": "25db300fcb6ee27f941a1b52c97856e8d1f13c7f35817f81a612f89af0e8a85c",
        # The alpha matte and the recurrent states; the foreground colour
        # (`fgr`) is never read
        "keep_outputs": ["pha", "r1o", "r2o", "r3o", "r4o"],
        # A constant: the app always feeds 1024×1024 frames, downsampled
        # inside the graph to 512 (the refiner restores full resolution)
        "fix_inputs": {"downsample_ratio": 0.5},
        # r1o…r4o also feed the next ConvGRU step inside the graph
        "isolate_outputs": True,
        "rename_dim_params": ["r1i", "r2i", "r3i", "r4i", "r1o", "r2o", "r3o", "r4o"],
        # The decoder's Convs read 771, 387, 131 and 35 channels
        "pad_conv_channels": True,
    },
]


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def check_pinned(path: Path, bytes_: int, sha256: str) -> str | None:
    """Why `path` does not match the pin, or None when it does."""
    size = path.stat().st_size
    if size != bytes_:
        return f"size {size} bytes, expected {bytes_}"
    actual = sha256_of(path)
    if actual != sha256:
        return f"SHA-256 {actual}, expected {sha256}"
    return None


def ensure_upstream(model: dict, src_dir: Path) -> Path:
    """The verified fp32 file, downloaded from its pinned commit if needed."""
    path = src_dir / model["fp32_file"]
    if path.exists():
        problem = check_pinned(path, model["upstream_bytes"], model["upstream_sha256"])
        if problem is None:
            return path
        sys.exit(f"{path}: {problem}")
    src_dir.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".download")
    print(f"{model['id']}: downloading {model['upstream_url']}", flush=True)
    urllib.request.urlretrieve(model["upstream_url"], tmp)
    problem = check_pinned(tmp, model["upstream_bytes"], model["upstream_sha256"])
    if problem is not None:
        tmp.unlink()
        sys.exit(f"{model['id']}: downloaded file rejected ({problem})")
    tmp.rename(path)
    return path


def keep_only_outputs(model: onnx.ModelProto, names: list[str]) -> int:
    """Drop every other graph output and whatever only fed it. Returns the
    number of nodes removed."""
    graph = model.graph
    missing = set(names) - {o.name for o in graph.output}
    if missing:
        raise ValueError(f"no graph output named {sorted(missing)}")
    kept = [o for o in graph.output if o.name in names]
    del graph.output[:]
    graph.output.extend(kept)

    needed = set(names)
    live = []
    for node in reversed(graph.node):
        if any(out in needed for out in node.output):
            live.append(node)
            needed.update(name for name in node.input if name)
    removed = len(graph.node) - len(live)
    live.reverse()
    del graph.node[:]
    graph.node.extend(live)

    initializers = [t for t in graph.initializer if t.name in needed]
    del graph.initializer[:]
    graph.initializer.extend(initializers)
    value_info = [v for v in graph.value_info if v.name in needed]
    del graph.value_info[:]
    graph.value_info.extend(value_info)
    return removed


def pad_conv_input_channels(model: onnx.ModelProto, multiple: int = 4) -> list[str]:
    """Zero-pad the input channels of every Conv whose input channel count
    is above and not a multiple of `multiple`. Returns "name: before -> after"
    for each Conv changed.

    onnxruntime-web 1.30's WebGPU backend computes such a Conv wrong (MODNet's
    Conv_304 has 99 input channels: its output is off by roughly its own
    magnitude, so the mask is garbage, while WASM and the CPU are right;
    every node before it matches the CPU to about 1e-6). A Pad node appends
    zero channels to the Conv's input and the weight gets as many zero input
    channels, so every output value is the same sum as before (plus zeros).
    Only plain Convs (group 1, weight stored as an initializer) are changed.
    """
    opset = next((o.version for o in model.opset_import if o.domain in ("", "ai.onnx")), 0)
    if opset < 11:
        raise ValueError(f"Pad with a pads input needs opset 11 or later, the model has {opset}")
    graph = model.graph
    initializers = {t.name: t for t in graph.initializer}
    nodes = []
    changed = []
    for node in graph.node:
        if node.op_type == "Conv" and node.input[1] in initializers:
            group = next((a.i for a in node.attribute if a.name == "group"), 1)
            weight = numpy_helper.to_array(initializers[node.input[1]])
            channels = weight.shape[1]
            if group == 1 and channels > multiple and channels % multiple:
                pad = multiple - channels % multiple
                zeros = np.zeros((weight.shape[0], pad, *weight.shape[2:]), weight.dtype)
                weight_name = f"{node.input[1]}_cpad"
                graph.initializer.append(
                    numpy_helper.from_array(np.concatenate([weight, zeros], axis=1), weight_name)
                )
                pads_name = f"{node.name}_cpad_pads"
                pads = np.zeros(2 * weight.ndim, np.int64)
                pads[weight.ndim + 1] = pad  # end of axis 1 (channels)
                graph.initializer.append(numpy_helper.from_array(pads, pads_name))
                padded = f"{node.input[0]}_cpad_{node.name}"
                nodes.append(
                    helper.make_node(
                        "Pad",
                        [node.input[0], pads_name],
                        [padded],
                        name=f"{node.name}_cpad",
                        mode="constant",
                    )
                )
                node.input[0] = padded
                node.input[1] = weight_name
                changed.append(f"{node.name}: {channels} -> {channels + pad}")
        nodes.append(node)
    del graph.node[:]
    graph.node.extend(nodes)
    # Drop the original weights nothing reads any more
    used = {name for node in graph.node for name in node.input}
    kept = [t for t in graph.initializer if t.name in used]
    del graph.initializer[:]
    graph.initializer.extend(kept)
    return changed


def isolate_outputs(model: onnx.ModelProto) -> list[str]:
    """Give every graph output that nodes also read its own Identity node.
    Returns the outputs changed.

    float16.convert_float_to_float16(keep_io_types=True) casts such an
    output back to float32 under its own name but leaves the nodes that read
    it reading that float32 tensor next to float16 ones (RVM's `r4o` feeds a
    Concat: "Type parameter (T) of Optype (Concat) bound to different
    types"). Behind an Identity, the nodes read the inner float16 tensor.
    """
    graph = model.graph
    read = {name for node in graph.node for name in node.input}
    changed = []
    for output in graph.output:
        if output.name not in read:
            continue
        inner = f"{output.name}_inner"
        for node in graph.node:
            node.output[:] = [inner if o == output.name else o for o in node.output]
            node.input[:] = [inner if i == output.name else i for i in node.input]
        graph.node.append(
            helper.make_node("Identity", [inner], [output.name], name=f"{output.name}_identity")
        )
        changed.append(output.name)
    return changed


def rename_dim_params(model: onnx.ModelProto, names: list[str]) -> None:
    """Prefix the symbolic dimensions of the graph inputs and outputs in
    `names` with the tensor's name ("height" -> "r1i_height").

    RVM's export names the dimensions of all four recurrent states
    "channels", "height" and "width" although each state has its own size.
    Once the float16 conversion puts Casts behind them, ONNX Runtime trusts
    the shared names and reuses one state's buffer for another ("Shape
    mismatch attempting to re-use buffer") from the second frame on.
    """
    graph = model.graph
    for value in [*graph.input, *graph.output]:
        if value.name not in names:
            continue
        for dim in value.type.tensor_type.shape.dim:
            if dim.dim_param and dim.dim_param != "batch_size":
                dim.dim_param = f"{value.name}_{dim.dim_param}"


def double_to_float(model: onnx.ModelProto) -> int:
    """Compute in float32 what the graph computes in float64. Returns the
    number of Casts and constants changed.

    BEN2 runs three of its LayerNorms in float64 (Cast to double, then the
    statistics); WebGPU has no float64, so session creation fails
    ("Provider type for … node is not set"). Their inputs are float16, so
    float32 holds every value they carry.
    """
    graph = model.graph
    double = onnx.TensorProto.DOUBLE
    changed = 0
    for node in graph.node:
        for attr in node.attribute:
            if node.op_type == "Cast" and attr.name == "to" and attr.i == double:
                attr.i = onnx.TensorProto.FLOAT
                changed += 1
            if node.op_type == "Constant" and attr.name == "value" and attr.t.data_type == double:
                value = numpy_helper.to_array(attr.t).astype(np.float32)
                attr.t.CopyFrom(numpy_helper.from_array(value, attr.t.name))
                changed += 1
    for i, tensor in enumerate(graph.initializer):
        if tensor.data_type == double:
            value = numpy_helper.to_array(tensor).astype(np.float32)
            graph.initializer[i].CopyFrom(numpy_helper.from_array(value, tensor.name))
            changed += 1
    for value_info in [*graph.value_info, *graph.input, *graph.output]:
        if value_info.type.tensor_type.elem_type == double:
            value_info.type.tensor_type.elem_type = onnx.TensorProto.FLOAT
    return changed


def square_pows(model: onnx.ModelProto) -> int:
    """Rewrite every Pow(x, 2) as Mul(x, x). Returns how many.

    BEN2's mixed-precision export squares float16 tensors with a float32
    exponent; onnxruntime-web has no kernel for that type pair, so session
    creation fails ("Provider type for Pow node … is not set"). x * x is
    the same value.
    """
    graph = model.graph
    constants = {t.name: numpy_helper.to_array(t) for t in graph.initializer}
    for node in graph.node:
        if node.op_type == "Constant":
            value = next((a.t for a in node.attribute if a.name == "value"), None)
            if value is not None:
                constants[node.output[0]] = numpy_helper.to_array(value)
    count = 0
    for node in graph.node:
        if node.op_type != "Pow" or node.input[1] not in constants:
            continue
        exponent = constants[node.input[1]]
        if exponent.size != 1 or float(exponent.reshape(-1)[0]) != 2.0:
            raise ValueError(f"{node.name}: Pow with an exponent other than 2")
        node.op_type = "Mul"
        node.input[1] = node.input[0]
        count += 1
    # Drop the exponent constants nothing reads any more
    used = {name for node in graph.node for name in node.input}
    kept = [n for n in graph.node if n.op_type != "Constant" or n.output[0] in used]
    del graph.node[:]
    graph.node.extend(kept)
    return count


def append_output_node(model: onnx.ModelProto, op_type: str, name: str, **attrs) -> None:
    """Feed the (single) graph output through one more node: `op_type`
    reads what the output was and the output now holds its result, under
    the same name unless `name` gives a new one."""
    graph = model.graph
    if len(graph.output) != 1:
        raise ValueError(f"{op_type} needs exactly one graph output")
    output = graph.output[0]
    old_name = output.name
    inner = f"{old_name}_before_{op_type.lower()}"
    for node in graph.node:
        node.output[:] = [inner if o == old_name else o for o in node.output]
        node.input[:] = [inner if i == old_name else i for i in node.input]
    graph.node.append(helper.make_node(op_type, [inner], [name], name=f"glinfs_{op_type}", **attrs))
    output.name = name
    if "to" in attrs:
        output.type.tensor_type.elem_type = attrs["to"]


def fix_inputs(model: onnx.ModelProto, values: dict[str, float]) -> None:
    """Turn graph inputs into constants (float32 tensors of shape [1])."""
    graph = model.graph
    for name, value in values.items():
        matches = [i for i in graph.input if i.name == name]
        if not matches:
            raise ValueError(f"no graph input named {name}")
        graph.input.remove(matches[0])
        graph.initializer.append(numpy_helper.from_array(np.array([value], np.float32), name))


def convert(model_def: dict, src: Path, out: Path) -> dict:
    model = onnx.load(str(src))
    removed = keep_only_outputs(model, model_def["keep_outputs"])
    padded = pad_conv_input_channels(model) if model_def.get("pad_conv_channels") else []
    steps = "; outputs kept: " + ", ".join(model_def["keep_outputs"])
    if model_def.get("fix_inputs"):
        fix_inputs(model, model_def["fix_inputs"])
        steps += "; inputs made constant: " + ", ".join(
            f"{k} = {v}" for k, v in model_def["fix_inputs"].items()
        )
    if model_def.get("isolate_outputs"):
        isolated = isolate_outputs(model)
        steps += "; outputs read inside the graph behind an Identity: " + ", ".join(isolated)
    if model_def.get("rename_dim_params"):
        rename_dim_params(model, model_def["rename_dim_params"])
        steps += "; symbolic dimensions of the recurrent states made distinct"
    if model_def.get("double_to_float"):
        steps += f"; float64 computed in float32 ({double_to_float(model)} Casts and constants)"
    if model_def.get("square_pows"):
        steps += f"; Pow(x, 2) rewritten as Mul(x, x) ({square_pows(model)} nodes)"
    clamped = 0
    if model_def.get("fp16", True):
        with warnings.catch_warnings(record=True) as caught:
            # A warning per tensor holding values of magnitude below 1e-7 (the
            # converter's min_positive_val), which are clamped to ±1e-7; counted
            warnings.simplefilter("always")
            model = float16.convert_float_to_float16(model, keep_io_types=True)
        clamped = sum("truncated" in str(w.message) for w in caught)
        conversion = ": float16.convert_float_to_float16(keep_io_types=True)"
    else:
        conversion = ": no float16 conversion (upstream is float16 already)"
    if model_def.get("cast_output_float32"):
        append_output_node(
            model, "Cast", model_def["cast_output_float32"], to=onnx.TensorProto.FLOAT
        )
        steps += f"; output cast to float32 as {model_def['cast_output_float32']}"
    del model.metadata_props[:]
    if padded:
        steps += "; Conv input channels zero-padded to a multiple of 4: " + ", ".join(padded)
    for key, value in (
        ("glinfs.converted_from", model_def["upstream_url"]),
        ("glinfs.converted_from_sha256", model_def["upstream_sha256"]),
        (
            "glinfs.conversion",
            f"onnx {onnx.__version__}, onnxconverter-common {onnxconverter_common.__version__}"
            + conversion
            + steps,
        ),
    ):
        model.metadata_props.add(key=key, value=value)
    onnx.checker.check_model(model)
    out.parent.mkdir(parents=True, exist_ok=True)
    onnx.save(model, str(out))
    return {
        "id": model_def["id"],
        "asset": model_def["asset"],
        "path": str(out),
        "bytes": out.stat().st_size,
        "sha256": sha256_of(out),
        "nodesRemoved": removed,
        "convsPadded": padded,
        "tensorsClamped": clamped,
        "convertedFrom": model_def["upstream_url"],
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0].strip())
    parser.add_argument("--src", required=True, type=Path, help="directory of the fp32 files")
    parser.add_argument("--out", required=True, type=Path, help="directory for the fp16 files")
    parser.add_argument("--only", choices=[m["id"] for m in MODELS], help="convert one model")
    args = parser.parse_args()

    results = []
    for model_def in MODELS:
        if args.only and model_def["id"] != args.only:
            continue
        src = ensure_upstream(model_def, args.src)
        print(f"{model_def['id']}: converting {src}", flush=True)
        results.append(convert(model_def, src, args.out / model_def["asset"]))
    print(json.dumps(results, indent=2))


if __name__ == "__main__":
    main()
