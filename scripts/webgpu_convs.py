"""
The WebGPU Conv rule, for the model conversion scripts.

onnxruntime-web's WebGPU backend (1.30 and 1.31.1) computes a Conv wrong when
its kernel is larger than 1 x 1 and its input has a number of channels that is
divisible by 3, not by 4, and more than 3 (6, 9, 15, 18, 21, 27, 30, 33 ... 99
...): measured on 190 one-Conv graphs on an NVIDIA GPU and on Chrome's
SwiftShader WebGPU adapter, with the same wrong values on both (see
src/features/ai-cutout/onnx-graph.js, the same rule in the app). Zero-padding
the input channels to a multiple of 4 gives exactly the same result.

- webgpu_conv_hazards(model): the Convs that hit the rule, "name: N channels, k x k";
- pad_conv_input_channels(model, only=...): the padding (a Pad node and zero
  weight channels), for every Conv it is given or the hazards only.

convert-models-fp16.py and export-birefnet-onnx.py pad the hazards and fail
when one is left in the file they write.
"""

from __future__ import annotations

from collections.abc import Callable

import numpy as np
import onnx
from onnx import helper, numpy_helper

#: Ops a weight may pass through on its way from an initializer to a Conv
PASS_THROUGH = {"Cast", "Identity", "DequantizeLinear"}


def _weight_dims(model: onnx.ModelProto, name: str) -> list[int] | None:
    initializers = {t.name: t for t in model.graph.initializer}
    producers = {out: node for node in model.graph.node for out in node.output}
    for _ in range(8):
        if name in initializers:
            return list(initializers[name].dims)
        node = producers.get(name)
        if node is None:
            return None
        if node.op_type == "Constant":
            value = next((a.t for a in node.attribute if a.name == "value"), None)
            return list(value.dims) if value is not None else None
        if node.op_type not in PASS_THROUGH:
            return None
        name = node.input[0]
    return None


def is_hazard(channels: int, kernel: list[int], group: int) -> bool:
    """The rule: group 1, kernel above 1 x 1, channels divisible by 3, not by 4, more than 3"""
    return group == 1 and any(k > 1 for k in kernel) and channels > 3 and channels % 3 == 0 and channels % 4 != 0


def webgpu_conv_hazards(model: onnx.ModelProto) -> list[str]:
    """The Convs of the main graph that WebGPU computes wrong"""
    found = []
    for node in model.graph.node:
        if node.op_type != "Conv" or len(node.input) < 2:
            continue
        dims = _weight_dims(model, node.input[1])
        if not dims or len(dims) < 3:
            continue
        kernel = next((list(a.ints) for a in node.attribute if a.name == "kernel_shape"), dims[2:])
        group = next((a.i for a in node.attribute if a.name == "group"), 1)
        if is_hazard(dims[1], kernel, group):
            found.append(f"{node.name or node.output[0]}: {dims[1]} channels, {' x '.join(map(str, kernel))}")
    return found


def pad_conv_input_channels(
    model: onnx.ModelProto,
    multiple: int = 4,
    only: Callable[[int, list[int]], bool] | None = None,
) -> list[str]:
    """Zero-pad the input channels of every Conv whose input channel count
    is above and not a multiple of `multiple` (and, with `only`, for which
    `only(channels, kernel)` holds). Returns "name: before -> after" for each
    Conv changed.

    onnxruntime-web's WebGPU backend computes some of those Convs wrong (see
    the module header; MODNet's Conv_304 has 99 input channels: its output is
    off by roughly its own magnitude, so the mask is garbage, while WASM and
    the CPU are right; every node before it matches the CPU to about 1e-6). A
    Pad node appends zero channels to the Conv's input and the weight gets as
    many zero input channels, so every output value is the same sum as before
    (plus zeros). Only plain Convs (group 1, weight stored as an initializer)
    are changed.
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
            kernel = list(weight.shape[2:])
            wanted = only is None or only(channels, kernel)
            if group == 1 and channels > multiple and channels % multiple and wanted:
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


def pad_webgpu_conv_hazards(model: onnx.ModelProto) -> list[str]:
    """Pad only the Convs that hit the rule"""
    return pad_conv_input_channels(model, only=lambda channels, kernel: is_hazard(channels, kernel, 1))


def assert_no_webgpu_conv_hazards(model: onnx.ModelProto, what: str) -> None:
    """Fail the conversion when a Conv WebGPU computes wrong is left"""
    left = webgpu_conv_hazards(model)
    if left:
        raise ValueError(
            f"{what}: onnxruntime-web WebGPU computes these Convs wrong (input channels divisible "
            f"by 3, not by 4): {', '.join(left)}. Pad their input channels to a multiple of 4."
        )
