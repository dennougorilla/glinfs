#!/usr/bin/env python3
"""
Export the BiRefNet models (general, lite, ToonOut) to the fp16 ONNX files
the app runs on WebGPU.

    python3.12 -m venv .venv-birefnet
    .venv-birefnet/bin/pip install -r scripts/requirements-birefnet.txt
    .venv-birefnet/bin/python scripts/export-birefnet-onnx.py --src SRC_DIR --out OUT_DIR [--only ID]

Unlike scripts/convert-models-fp16.py, the upstream files are PyTorch
checkpoints (no ONNX export is published that runs in the browser), so this
script exports them itself. For each model below it:

1. downloads the checkpoint and BiRefNet's model code (`birefnet.py`,
   `BiRefNet_config.py`) from their pinned Hugging Face commits into
   SRC_DIR, when missing, and checks each against its pinned size and
   SHA-256;
2. exports the final prediction (logits; the app applies the sigmoid,
   `preprocess.output: 'logits'`) with the TorchScript exporter, opset 17,
   input `input_image` float32 [1, 3, 1024, 1024], output `output_image`.
   torchvision's deform_conv2d has no ONNX op: deform_conv2d_onnx_exporter
   decomposes it into GatherND and index arithmetic. torch 2.6 leaves the
   deform_conv2d operand sizes unknown in the TorchScript graph, so an eager
   run records them first (record_deform_shapes);
3. runs ONNX Runtime's basic offline optimisation (constant folding and
   redundant-node removal; no fused contrib ops), then converts to float16
   with onnxconverter-common, `keep_io_types=True` (the input and output
   stay float32), like the other shipped models;
4. applies four rewrites that compute the same values but let
   onnxruntime-web 1.30's WebGPU backend run the graph:
   - split_wide_nodes: a Split with more than 7 outputs becomes one Slice
     per output, and a Concat with more than 7 inputs becomes a tree of
     Concats. Without this the session fails with "Too many storage buffers
     in shader. Current: 17, Max is 16" (WebGPU binds every input and output
     as a storage buffer; some GPUs allow only 8);
   - sum_to_add: Sum becomes a chain of Add (WebGPU has no Sum kernel, so
     ORT ran 20 large Sums on the CPU and ran out of WASM memory);
   - float_index: deform_conv2d's int64 index arithmetic (Cast to int64 →
     Slice/Add/Clip/Reshape/Concat → GatherND) runs in float32, cast to
     int64 right before GatherND. WebGPU has no int64 Add/Clip/Concat
     kernels, so ORT put 300 nodes on the CPU (about 960 ms per frame
     instead of 485 on an RTX 3080 Ti). The values are small integers,
     exact in float32;
   - pool_float32: GlobalAveragePool and ReduceMean run in float32 (Cast
     in, Cast out). WebGPU's float16 GlobalAveragePool overflows on the
     256×256 maps of the decoder's ASPP branch and returns NaN, which would
     be an empty mask on many frames (ToonOut: 217 of 422 test frames);
5. validates the result with the ONNX checker and prints its size and
   SHA-256, which must equal the pins in
   src/features/ai-cutout/model-registry.js.

With the versions in scripts/requirements-birefnet.txt the export runs on
the CPU and is reproducible byte for byte: run on 2026-11-16 (Windows,
Python 3.12), it printed exactly the pinned sizes and SHA-256s of all three
files. The pinned files were checked against PyTorch fp32 on CUDA (mean
absolute difference at most 0.012 on 3 frames of each of 10 test clips) and
against ONNX Runtime on the CPU (97–99.98% of pixels agree after
thresholding at 0.5). Each export takes a few minutes and about 3 GB of
RAM; the upstream downloads are 444, 178 and 885 MB.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import sys
import types
import urllib.request
from pathlib import Path

# BiRefNet's model code at the pinned commits (the general model's code is
# also the ToonOut checkpoint's architecture: a fine-tune of BiRefNet)
BIREFNET_CODE = [
    {
        "path": "birefnet.py",
        "upstream_url": "https://huggingface.co/ZhengPeng7/BiRefNet/resolve/"
        "e2bf8e4460fc8fa32bba5ea4d94b3233d367b0e4/birefnet.py",
        "upstream_bytes": 91_896,
        "upstream_sha256": "208771ae626f653d64128fbf2d6ac9f8e645c5cc5e286258a73ec3322bbfe5ef",
    },
    {
        "path": "BiRefNet_config.py",
        "upstream_url": "https://huggingface.co/ZhengPeng7/BiRefNet/resolve/"
        "e2bf8e4460fc8fa32bba5ea4d94b3233d367b0e4/BiRefNet_config.py",
        "upstream_bytes": 298,
        "upstream_sha256": "e7b8c2a74f6cea6a59553d517f71d47f2c1d90e670a13416af17c25fe2f3dc52",
    },
]
LITE_CODE = [
    {
        "path": "birefnet.py",
        "upstream_url": "https://huggingface.co/ZhengPeng7/BiRefNet_lite/resolve/"
        "aa62cd87eafb9cc43056d08ef3615a14628b831d/birefnet.py",
        "upstream_bytes": 92_134,
        "upstream_sha256": "af8568b5be406bf4d2a68a7ed6d72e40f73b37a1fb6fc9ebd71b5b3cbcd069c9",
    },
    {
        "path": "BiRefNet_config.py",
        "upstream_url": "https://huggingface.co/ZhengPeng7/BiRefNet_lite/resolve/"
        "aa62cd87eafb9cc43056d08ef3615a14628b831d/BiRefNet_config.py",
        "upstream_bytes": 298,
        "upstream_sha256": "e7b8c2a74f6cea6a59553d517f71d47f2c1d90e670a13416af17c25fe2f3dc52",
    },
]

# One entry per shipped model. tests/unit/ai-cutout/model-config.test.js
# checks the ids, asset names and upstream pins against the registry.
MODELS = [
    {
        "id": "birefnet-general",
        "asset": "birefnet-general-fp16.onnx",
        "code_dir": "BiRefNet@e2bf8e4",
        "code": BIREFNET_CODE,
        "weights_file": "BiRefNet-model.safetensors",
        "upstream_url": "https://huggingface.co/ZhengPeng7/BiRefNet/resolve/"
        "e2bf8e4460fc8fa32bba5ea4d94b3233d367b0e4/model.safetensors",
        "upstream_bytes": 444_473_596,
        "upstream_sha256": "9ab37426bf4de0567af6b5d21b16151357149139362e6e8992021b8ce356a154",
    },
    {
        "id": "birefnet-lite",
        "asset": "birefnet-lite-fp16.onnx",
        "code_dir": "BiRefNet_lite@aa62cd8",
        "code": LITE_CODE,
        "weights_file": "BiRefNet_lite-model.safetensors",
        "upstream_url": "https://huggingface.co/ZhengPeng7/BiRefNet_lite/resolve/"
        "aa62cd87eafb9cc43056d08ef3615a14628b831d/model.safetensors",
        "upstream_bytes": 177_634_392,
        "upstream_sha256": "4417d89795250e698c3cb0ae8df15743810065f646f48a694fdfa7ca052d0815",
    },
    {
        "id": "birefnet-toonout",
        "asset": "birefnet-toonout-fp16.onnx",
        "code_dir": "BiRefNet@e2bf8e4",
        "code": BIREFNET_CODE,
        "weights_file": "birefnet_finetuned_toonout.pth",
        "upstream_url": "https://huggingface.co/joelseytre/toonout/resolve/"
        "cbf720eca394edcde66b861a8a8c20fbabe9c748/birefnet_finetuned_toonout.pth",
        "upstream_bytes": 885_046_394,
        "upstream_sha256": "8c7f8a0bc24400f4caade76622f75ff22ca1e93e169add9d2b70093e2487fbe5",
    },
]

INPUT_SIZE = 1024
INPUT_NAME = "input_image"
OUTPUT_NAME = "output_image"
OPSET = 17
# Most inputs/outputs a rewritten Split or Concat keeps
MAX_IO = 7
POOL_OPS = ("GlobalAveragePool", "ReduceMean")


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


def fetch_pinned(path: Path, pin: dict) -> None:
    """Download `pin` to `path` unless a verified copy is there."""
    if path.exists():
        problem = check_pinned(path, pin["upstream_bytes"], pin["upstream_sha256"])
        if problem is None:
            return
        raise SystemExit(f"{path}: {problem} (delete it to download again)")
    path.parent.mkdir(parents=True, exist_ok=True)
    print(f"downloading {pin['upstream_url']}")
    tmp = path.with_name(path.name + ".download")
    urllib.request.urlretrieve(pin["upstream_url"], tmp)
    problem = check_pinned(tmp, pin["upstream_bytes"], pin["upstream_sha256"])
    if problem:
        tmp.unlink()
        raise SystemExit(f"{pin['upstream_url']}: {problem}")
    tmp.rename(path)


# ---------------------------------------------------------------------------
# PyTorch export
# ---------------------------------------------------------------------------


def load_birefnet_module(code_dir: Path):
    """Import birefnet.py as a submodule of a package rooted at code_dir
    (it does `from .BiRefNet_config import ...`); code_dir is not put on
    sys.path."""
    pkg = types.ModuleType("birefnet_pkg")
    pkg.__path__ = [str(code_dir)]
    sys.modules["birefnet_pkg"] = pkg
    spec = importlib.util.spec_from_file_location(
        "birefnet_pkg.birefnet", code_dir / "birefnet.py"
    )
    module = importlib.util.module_from_spec(spec)
    sys.modules["birefnet_pkg.birefnet"] = module
    spec.loader.exec_module(module)
    return module


def load_model(module, weights: Path):
    import torch

    model = module.BiRefNet(bb_pretrained=False)
    if weights.suffix == ".safetensors":
        from safetensors.torch import load_file

        state = load_file(str(weights))
    else:
        state = torch.load(str(weights), map_location="cpu", weights_only=True)
        if isinstance(state, dict) and "state_dict" in state:
            state = state["state_dict"]

    def strip(key: str) -> str:
        # ToonOut's checkpoint was saved from a DDP-wrapped, compiled model
        for prefix in ("module.", "_orig_mod."):
            key = key.removeprefix(prefix)
        return key

    state = {strip(k): v for k, v in state.items()}
    missing, _unexpected = model.load_state_dict(state, strict=False)
    if missing:
        raise SystemExit(f"{weights}: {len(missing)} weights missing, e.g. {missing[:3]}")
    return model.eval()


def record_deform_shapes(module, model, x) -> None:
    """Hand deform_conv2d_onnx_exporter the operand shapes of an eager run
    (same input size, so the same shapes), in call order; a size the
    exporter can read from the graph wins."""
    import deform_conv2d_onnx_exporter as dce
    import torch
    import torchvision.ops

    shapes = []
    real = torchvision.ops.deform_conv2d

    def recording(input, offset, weight, *args, **kwargs):
        shapes.append((tuple(input.shape), tuple(offset.shape)))
        return real(input, offset, weight, *args, **kwargs)

    module.deform_conv2d = recording
    with torch.no_grad():
        model(x)
    module.deform_conv2d = real
    print(f"  recorded {len(shapes)} deform_conv2d calls")
    if not shapes:
        raise SystemExit("no deform_conv2d call recorded: birefnet.py changed?")
    real_create = dce.create_dcn_params
    real_dim = dce.get_tensor_dim_size
    calls = iter(shapes)

    def create_with_shapes(input, weight, offset, *rest):
        in_shape, off_shape = next(calls)

        def dim(tensor, d):
            value = real_dim(tensor, d)
            if value is not None:
                return value
            if tensor is input:
                return in_shape[d]
            if tensor is offset:
                return off_shape[d]
            raise RuntimeError("unknown deform_conv2d operand")

        dce.get_tensor_dim_size = dim
        try:
            return real_create(input, weight, offset, *rest)
        finally:
            dce.get_tensor_dim_size = real_dim

    dce.create_dcn_params = create_with_shapes


def export_fp32(code_dir: Path, weights: Path, out: Path) -> None:
    import deform_conv2d_onnx_exporter
    import torch

    class FinalPrediction(torch.nn.Module):
        # The attribute name `m` is in every node and weight name of the
        # graph (`/m/decoder/...`), so it is part of the pinned bytes
        def __init__(self, m):
            super().__init__()
            self.m = m

        def forward(self, x):
            return self.m(x)[-1]

    torch.manual_seed(0)
    deform_conv2d_onnx_exporter.register_deform_conv2d_onnx_op()
    module = load_birefnet_module(code_dir)
    model = FinalPrediction(load_model(module, weights))
    x = torch.randn(1, 3, INPUT_SIZE, INPUT_SIZE)
    import deform_conv2d_onnx_exporter as dce

    original_create = dce.create_dcn_params
    record_deform_shapes(module, model, x)
    try:
        with torch.no_grad():
            torch.onnx.export(
                model,
                (x,),
                str(out),
                opset_version=OPSET,
                input_names=[INPUT_NAME],
                output_names=[OUTPUT_NAME],
                do_constant_folding=True,
                dynamo=False,
            )
    finally:
        # The next model records its own shapes
        dce.create_dcn_params = original_create


# ---------------------------------------------------------------------------
# fp16 and the WebGPU rewrites (each step reads and writes a file)
# ---------------------------------------------------------------------------


def fold(src: Path, dst: Path) -> None:
    """ORT basic offline optimisation on the CPU. Without it
    onnxconverter-common leaves Swin's int→float→Ceil padding maths with
    mixed float16/float32 inputs."""
    import onnxruntime as ort

    options = ort.SessionOptions()
    options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_BASIC
    options.optimized_model_filepath = str(dst)
    ort.InferenceSession(str(src), options, providers=["CPUExecutionProvider"])


def to_float16(src: Path, dst: Path) -> None:
    import onnx
    from onnxconverter_common import float16

    model = float16.convert_float_to_float16(onnx.load(str(src)), keep_io_types=True)
    # The converter leaves stale value_info (float where a Cast now yields
    # float16), which ORT rejects: let ORT infer the types instead
    del model.graph.value_info[:]
    onnx.save(model, str(dst))


def _const_value(model, name):
    from onnx import numpy_helper

    for init in model.graph.initializer:
        if init.name == name:
            return numpy_helper.to_array(init)
    for node in model.graph.node:
        if node.op_type == "Constant" and node.output[0] == name:
            for attr in node.attribute:
                if attr.name == "value":
                    return numpy_helper.to_array(attr.t)
    return None


def _rank_of(model, inferred, name):
    for vi in [*inferred.graph.value_info, *model.graph.input, *model.graph.output]:
        if vi.name == name and vi.type.tensor_type.HasField("shape"):
            return len(vi.type.tensor_type.shape.dim)
    return None


def split_wide_nodes(src: Path, dst: Path, limit: int = MAX_IO) -> None:
    """Split/Concat with more than `limit` outputs/inputs → Slices / a
    Concat tree; Sum → a chain of Add (see the module comment)."""
    import numpy as np
    import onnx
    from onnx import helper, numpy_helper, shape_inference

    model = onnx.load(str(src))
    try:
        inferred = shape_inference.infer_shapes(model)
    except Exception:  # noqa: BLE001 - ranks are only needed for negative axes
        inferred = model
    nodes = []
    uid = 0
    counts = {"Split": 0, "Concat": 0, "Sum": 0}
    for node in model.graph.node:
        if node.op_type == "Split" and len(node.output) > limit:
            axis = next((a.i for a in node.attribute if a.name == "axis"), 0)
            if axis < 0:
                rank = _rank_of(model, inferred, node.input[0])
                if rank is None:
                    raise SystemExit(f"Split {node.name}: negative axis and unknown rank")
                axis += rank
            sizes = _const_value(model, node.input[1]) if len(node.input) > 1 and node.input[1] else None
            if sizes is None:
                sizes = next((list(a.ints) for a in node.attribute if a.name == "split"), None)
            if sizes is None:
                raise SystemExit(f"Split {node.name}: an equal split without sizes is not handled")
            start = 0
            for out, size in zip(node.output, [int(s) for s in sizes]):
                uid += 1
                names = [f"_fx{uid}_{k}" for k in ("s", "e", "a")]
                for name, value in zip(names, (start, start + size, axis)):
                    nodes.append(
                        helper.make_node(
                            "Constant",
                            [],
                            [name],
                            value=numpy_helper.from_array(np.array([value], np.int64)),
                        )
                    )
                nodes.append(
                    helper.make_node(
                        "Slice", [node.input[0], *names], [out], name=f"{node.name}_slice{uid}"
                    )
                )
                start += size
            counts["Split"] += 1
            continue
        if node.op_type == "Concat" and len(node.input) > limit:
            axis = next(a.i for a in node.attribute if a.name == "axis")
            inputs = list(node.input)
            level = 0
            while len(inputs) > limit:
                grouped = []
                for i in range(0, len(inputs), limit):
                    chunk = inputs[i : i + limit]
                    if len(chunk) == 1:
                        grouped.append(chunk[0])
                        continue
                    uid += 1
                    out = f"_fx{uid}_cat{level}"
                    nodes.append(
                        helper.make_node("Concat", chunk, [out], axis=axis, name=f"{node.name}_c{uid}")
                    )
                    grouped.append(out)
                inputs = grouped
                level += 1
            nodes.append(helper.make_node("Concat", inputs, list(node.output), axis=axis, name=node.name))
            counts["Concat"] += 1
            continue
        if node.op_type == "Sum" and len(node.input) > 1:
            acc = node.input[0]
            for i, term in enumerate(node.input[1:]):
                uid += 1
                out = node.output[0] if i == len(node.input) - 2 else f"_fx{uid}_sum"
                nodes.append(helper.make_node("Add", [acc, term], [out], name=f"{node.name}_add{uid}"))
                acc = out
            counts["Sum"] += 1
            continue
        nodes.append(node)
    del model.graph.node[:]
    model.graph.node.extend(nodes)
    onnx.checker.check_model(model)
    onnx.save(model, str(dst))
    print(f"  rewrote {counts['Split']} Split, {counts['Concat']} Concat, {counts['Sum']} Sum")


# Ops of deform_conv2d's index chain, and which of their inputs are data
# (converted to float32); the others (Slice starts, Reshape shape) stay int64
CHAIN_DATA_INPUTS = {
    "Slice": (0,),
    "Add": (0, 1),
    "Sub": (0, 1),
    "Mul": (0, 1),
    "Clip": (0, 1, 2),
    "Reshape": (0,),
    "Concat": None,
    "Unsqueeze": (0,),
    "Squeeze": (0,),
}


def float_index(src: Path, dst: Path) -> None:
    """Keep deform_conv2d's GatherND index arithmetic in float32."""
    import numpy as np
    import onnx
    from onnx import TensorProto, helper, numpy_helper

    model = onnx.load(str(src))
    graph = model.graph
    inits = {i.name: i for i in graph.initializer}
    consts = {n.output[0]: n for n in graph.node if n.op_type == "Constant"}
    consumers: dict[str, list] = {}
    for node in graph.node:
        for name in node.input:
            consumers.setdefault(name, []).append(node)

    casts = [
        n
        for n in graph.node
        if n.op_type == "Cast" and next(a.i for a in n.attribute if a.name == "to") == TensorProto.INT64
    ]
    chain = set()
    gather_inputs = set()
    for cast in casts:
        stack = [cast.output[0]]
        seen = set()
        only_chain = True
        local = []
        while stack:
            tensor = stack.pop()
            if tensor in seen:
                continue
            seen.add(tensor)
            for node in consumers.get(tensor, []):
                if node.op_type == "GatherND" and node.input[1] == tensor:
                    gather_inputs.add(tensor)
                elif node.op_type in CHAIN_DATA_INPUTS:
                    local.append(node)
                    stack.extend(node.output)
                else:
                    only_chain = False
        if only_chain and local:
            chain.update(id(n) for n in local)
            for attr in cast.attribute:
                if attr.name == "to":
                    attr.i = TensorProto.FLOAT

    float_copies: dict[str, str] = {}

    def as_float(name: str):
        if name in float_copies:
            return float_copies[name]
        if name in inits:
            array = numpy_helper.to_array(inits[name])
        elif name in consts:
            array = numpy_helper.to_array(
                next(a.t for a in consts[name].attribute if a.name == "value")
            )
        else:
            return None
        if array.dtype != np.int64:
            return name
        copy = name + "_f32"
        graph.initializer.append(numpy_helper.from_array(array.astype(np.float32), copy))
        float_copies[name] = copy
        return copy

    converted = 0
    for node in graph.node:
        if id(node) not in chain:
            continue
        data_inputs = CHAIN_DATA_INPUTS[node.op_type]
        for k, name in enumerate(node.input):
            if not name or (data_inputs is not None and k not in data_inputs):
                continue
            copy = as_float(name)
            if copy is not None and copy != name:
                node.input[k] = copy
        converted += 1

    nodes = []
    for node in graph.node:
        if node.op_type == "GatherND" and node.input[1] in gather_inputs:
            index = node.input[1] + "_i64"
            nodes.append(
                helper.make_node(
                    "Cast", [node.input[1]], [index], to=TensorProto.INT64, name=node.name + "_idx_cast"
                )
            )
            node.input[1] = index
        nodes.append(node)
    del graph.node[:]
    graph.node.extend(nodes)
    del graph.value_info[:]
    onnx.checker.check_model(model)
    onnx.save(model, str(dst))
    print(f"  float32 index chains: {len(casts)} casts, {converted} nodes, {len(gather_inputs)} GatherND")


def pool_float32(src: Path, dst: Path, ops: tuple[str, ...] = POOL_OPS) -> None:
    """Run `ops` in float32: Cast the inputs to float32 (float16 weights get
    float32 copies) and the outputs back to float16."""
    import numpy as np
    import onnx
    from onnx import TensorProto, helper, numpy_helper

    model = onnx.load(str(src))
    graph = model.graph
    inits = {i.name: i for i in graph.initializer}
    nodes = []
    done = 0
    copies: dict[str, str] = {}
    for node in graph.node:
        if node.op_type not in ops:
            nodes.append(node)
            continue
        for k, name in enumerate(node.input):
            if not name:
                continue
            if name in inits and inits[name].data_type == TensorProto.FLOAT16:
                if name not in copies:
                    copies[name] = name + "_f32"
                    graph.initializer.append(
                        numpy_helper.from_array(
                            numpy_helper.to_array(inits[name]).astype(np.float32), copies[name]
                        )
                    )
                node.input[k] = copies[name]
            elif name not in inits:
                cast = f"{name}_to32_{done}_{k}"
                nodes.append(
                    helper.make_node("Cast", [name], [cast], to=TensorProto.FLOAT, name=f"{node.name}_in{k}_f32")
                )
                node.input[k] = cast
        outputs = list(node.output)
        for k, out in enumerate(outputs):
            if out:
                node.output[k] = f"{out}_f32out"
        nodes.append(node)
        for k, out in enumerate(outputs):
            if out:
                nodes.append(
                    helper.make_node(
                        "Cast", [f"{out}_f32out"], [out], to=TensorProto.FLOAT16, name=f"{node.name}_out{k}_f16"
                    )
                )
        done += 1
    del graph.node[:]
    graph.node.extend(nodes)
    del graph.value_info[:]
    onnx.checker.check_model(model)
    onnx.save(model, str(dst))
    print(f"  {done} {'/'.join(ops)} nodes in float32")


def build(entry: dict, src_dir: Path, out_dir: Path, keep_intermediate: bool) -> Path:
    code_dir = src_dir / entry["code_dir"]
    for pin in entry["code"]:
        fetch_pinned(code_dir / pin["path"], pin)
    weights = src_dir / entry["weights_file"]
    fetch_pinned(weights, entry)

    out_dir.mkdir(parents=True, exist_ok=True)
    work = out_dir / f".{entry['id']}"
    work.mkdir(exist_ok=True)
    fp32 = work / "fp32.onnx"
    steps = [
        ("export (TorchScript, opset 17)", None),
        ("fold (ORT basic)", fold),
        ("float16", to_float16),
        ("split wide Split/Concat, Sum to Add", split_wide_nodes),
        ("float32 index maths", float_index),
        ("pooling in float32", pool_float32),
    ]
    print(f"{entry['id']}: {steps[0][0]}")
    export_fp32(code_dir, weights, fp32)
    current = fp32
    for i, (label, step) in enumerate(steps[1:], start=1):
        print(f"{entry['id']}: {label}")
        target = work / f"step{i}.onnx"
        step(current, target)
        if current != fp32 and not keep_intermediate:
            current.unlink()
        current = target
    # No BiRefNet Conv hits the WebGPU rule (scripts/webgpu_convs.py); a
    # later checkpoint whose Convs do gets them padded here
    import onnx
    from webgpu_convs import assert_no_webgpu_conv_hazards, pad_webgpu_conv_hazards

    print(f"{entry['id']}: WebGPU Conv check")
    model = onnx.load(str(current))
    padded = pad_webgpu_conv_hazards(model)
    if padded:
        print(f"{entry['id']}: Conv input channels zero-padded: {', '.join(padded)}")
        onnx.save(model, str(current))
    assert_no_webgpu_conv_hazards(model, entry["id"])
    final = out_dir / entry["asset"]
    current.replace(final)
    if not keep_intermediate:
        fp32.unlink()
        work.rmdir()
    return final


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--src", type=Path, required=True, help="upstream downloads (checkpoints, code)")
    parser.add_argument("--out", type=Path, required=True, help="where the .onnx files are written")
    parser.add_argument("--only", choices=[m["id"] for m in MODELS], action="append")
    parser.add_argument("--keep-intermediate", action="store_true")
    args = parser.parse_args()
    for entry in MODELS:
        if args.only and entry["id"] not in args.only:
            continue
        final = build(entry, args.src, args.out, args.keep_intermediate)
        print(f"{entry['asset']}: {final.stat().st_size} bytes, SHA-256 {sha256_of(final)}")


if __name__ == "__main__":
    main()
