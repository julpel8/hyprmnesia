"""Minimal Hailo inference wrapper for the OCR pipeline.

Trimmed from hailo-ai/hailo-apps (Apache-2.0),
hailo_apps/python/core/common/hailo_inference.py. Repo-specific pieces (NMS
special-casing, input format override, multi-model bookkeeping) were removed;
the VDevice round-robin setup and the async bindings are kept as-is because
that is the path the PaddleOCR HEF models were validated against.
"""

from functools import partial

import numpy as np
from hailo_platform import HEF, VDevice, FormatType, HailoSchedulingAlgorithm


class HailoInfer:
    def __init__(self, hef_path, batch_size=1, priority=0):
        params = VDevice.create_params()
        # Round-robin scheduling activates the scheduler on the shared VDevice.
        params.scheduling_algorithm = HailoSchedulingAlgorithm.ROUND_ROBIN
        params.group_id = "SHARED"
        vdevice = VDevice(params)
        self.hef = HEF(hef_path)
        self.infer_model = vdevice.create_infer_model(hef_path)
        self.infer_model.set_batch_size(batch_size)
        # Output dtypes straight from the HEF metadata, e.g.
        # {"det_output": "float32", "ocr_output": "uint8"}.
        self.output_type = {
            info.name: str(info.format.type).split(".")[-1]
            for info in self.hef.get_output_vstream_infos()
        }
        # The reference HailoInfer pins every output format before configure();
        # without it HailoRT routes the async job through a frame-accumulator
        # path that needs the dataflow scheduler and times out on these HEFs.
        for name, dtype in self.output_type.items():
            self.infer_model.output(name).set_format_type(getattr(FormatType, dtype))
        self.config_ctx = self.infer_model.configure()
        self.configured_model = self.config_ctx.__enter__()
        self.configured_model.set_scheduler_priority(priority)
        self.last_infer_job = None

    def get_input_shape(self):
        return self.hef.get_input_vstream_infos()[0].shape

    def run(self, frames, callback):
        """Launch async inference on a batch of preprocessed inputs.

        The callback is invoked as ``callback(completion_info,
        bindings_list=...)`` when the job finishes. Returns the job handle;
        callers wanting a synchronous result call ``job.wait(timeout_ms)``.
        """
        bindings = []
        for frame in frames:
            output_buffers = {
                name: np.empty(
                    self.infer_model.output(name).shape,
                    dtype=getattr(np, self.output_type[name].lower()),
                )
                for name in self.output_type
            }
            binding = self.configured_model.create_bindings(output_buffers=output_buffers)
            binding.input().set_buffer(np.array(frame))
            bindings.append(binding)
        self.configured_model.wait_for_async_ready(timeout_ms=10000)
        self.last_infer_job = self.configured_model.run_async(
            bindings, partial(callback, bindings_list=bindings)
        )
        return self.last_infer_job

    def close(self):
        if self.last_infer_job is not None:
            self.last_infer_job.wait(10000)
        if self.config_ctx:
            self.config_ctx.__exit__(None, None, None)
