#!/usr/bin/env python3
"""
Generate the test graphs of the WebGPU Conv check (src/features/ai-cutout/onnx-graph.js):

    .venv-models/bin/python scripts/generate-conv-rule-fixture.py

One graph with eight Convs (random weights, fixed seed), each a case of the
WebGPU Conv check: 6 input / 4 output channels 3 x 3 (wrong on WebGPU), the
same dilated by 2 (wrong), 8 input channels, a 1 x 1 kernel and 3 output
channels (right), 33 channels with an fp16 weight behind a Cast and 99
channels with a Constant weight (wrong; the reader has to follow the weight
to its shape), and a grouped Conv (not flagged).

tests/fixtures/models/stub-seg-conv6.onnx: the anime stub's interface (input
`img` [1, 3, 1024, 1024], output `mask` [1, 1, 1024, 1024]) through a Conv
WebGPU computes wrong: the image twice (6 channels), then a 3 x 3 Conv to 4
channels whose weights all equal 1/54, then their mean, so the mask is the
mean brightness (slightly blurred), as the plain stub gives, on WASM; the Add
model dialog flags the Conv.
"""

from pathlib import Path

import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper

FIXTURES = Path(__file__).resolve().parent.parent / "tests/fixtures/models"
OUT = FIXTURES / "webgpu-conv-rule.onnx"
STUB = FIXTURES / "stub-seg-conv6.onnx"


def stub_conv6() -> None:
    weight = np.full((4, 6, 3, 3), 1 / 54, np.float32)
    nodes = [
        helper.make_node("Concat", ["img", "img"], ["img6"], name="twice", axis=1),
        helper.make_node("Conv", ["img6", "w"], ["four"], name="conv6_3x3", kernel_shape=[3, 3], pads=[1, 1, 1, 1]),
        helper.make_node("ReduceMean", ["four"], ["mask"], name="mean", axes=[1], keepdims=1),
    ]
    model = helper.make_model(
        helper.make_graph(
            nodes,
            "stub_seg_conv6",
            [helper.make_tensor_value_info("img", TensorProto.FLOAT, [1, 3, 1024, 1024])],
            [helper.make_tensor_value_info("mask", TensorProto.FLOAT, [1, 1, 1024, 1024])],
            [numpy_helper.from_array(weight, "w")],
        ),
        opset_imports=[helper.make_opsetid("", 11)],
    )
    model.ir_version = 6
    onnx.checker.check_model(model)
    onnx.save(model, str(STUB))
    print(STUB, STUB.stat().st_size)


def main() -> None:
    rng = np.random.default_rng(0)

    def weight(cout: int, cin: int, k: int, dtype=np.float32) -> np.ndarray:
        return (rng.standard_normal((cout, cin, k, k)) * 0.1).astype(dtype)

    nodes = []
    inits = [
        numpy_helper.from_array(weight(4, 6, 3), "w6"),
        numpy_helper.from_array(weight(4, 8, 3), "w8"),
        numpy_helper.from_array(weight(4, 6, 1), "w6k1"),
        numpy_helper.from_array(weight(4, 33, 3, np.float16), "w33h"),
        numpy_helper.from_array(weight(4, 3, 3), "wg"),
        numpy_helper.from_array(weight(3, 6, 3), "w6o3"),
    ]

    def conv(name: str, x: str, w: str, k: int, out: str, group: int = 1, dilation: int = 1) -> None:
        nodes.append(
            helper.make_node(
                "Conv",
                [x, w],
                [out],
                name=name,
                kernel_shape=[k, k],
                pads=[dilation * (k // 2)] * 4,
                dilations=[dilation, dilation],
                group=group,
            )
        )

    conv("conv_hazard_6", "x6", "w6", 3, "y1")
    conv("conv_ok_8", "x8", "w8", 3, "y2")
    conv("conv_ok_1x1", "x6", "w6k1", 1, "y3")
    nodes.append(helper.make_node("Cast", ["w33h"], ["w33"], name="cast_w33", to=TensorProto.FLOAT))
    conv("conv_cast_33", "x33", "w33", 3, "y4")
    nodes.append(
        helper.make_node(
            "Constant", [], ["w99"], name="const_w99", value=numpy_helper.from_array(weight(4, 99, 3), "w99v")
        )
    )
    conv("conv_const_99", "x99", "w99", 3, "y5")
    conv("conv_group_2x3", "x6", "wg", 3, "y6", group=2)
    conv("conv_ok_out3", "x6", "w6o3", 3, "y7")
    conv("conv_dilated_6", "x6", "w6", 3, "y8", dilation=2)
    inputs = [
        helper.make_tensor_value_info(name, TensorProto.FLOAT, [1, c, 8, 8])
        for name, c in (("x6", 6), ("x8", 8), ("x33", 33), ("x99", 99))
    ]
    outputs = [helper.make_tensor_value_info(f"y{i}", TensorProto.FLOAT, [1, 4, 8, 8]) for i in range(1, 7)]
    outputs.append(helper.make_tensor_value_info("y7", TensorProto.FLOAT, [1, 3, 8, 8]))
    outputs.append(helper.make_tensor_value_info("y8", TensorProto.FLOAT, [1, 4, 8, 8]))
    model = helper.make_model(
        helper.make_graph(nodes, "webgpu_conv_rule", inputs, outputs, inits),
        opset_imports=[helper.make_opsetid("", 17)],
    )
    model.ir_version = 8
    onnx.checker.check_model(model)
    onnx.save(model, str(OUT))
    print(OUT, OUT.stat().st_size)
    stub_conv6()


if __name__ == "__main__":
    main()
