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

import onnx
import onnxconverter_common
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


def convert(model_def: dict, src: Path, out: Path) -> dict:
    model = onnx.load(str(src))
    removed = keep_only_outputs(model, model_def["keep_outputs"])
    with warnings.catch_warnings(record=True) as caught:
        # A warning per tensor holding values of magnitude below 1e-7 (the
        # converter's min_positive_val), which are clamped to ±1e-7; counted
        warnings.simplefilter("always")
        model = float16.convert_float_to_float16(model, keep_io_types=True)
    clamped = sum("truncated" in str(w.message) for w in caught)
    del model.metadata_props[:]
    for key, value in (
        ("glinfs.converted_from", model_def["upstream_url"]),
        ("glinfs.converted_from_sha256", model_def["upstream_sha256"]),
        (
            "glinfs.conversion",
            f"onnx {onnx.__version__}, onnxconverter-common {onnxconverter_common.__version__}"
            ": float16.convert_float_to_float16(keep_io_types=True); outputs kept: "
            + ", ".join(model_def["keep_outputs"]),
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
