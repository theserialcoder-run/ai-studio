import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Local TTS (Kokoro) uses a native ONNX runtime and reads bundled voice files
  // relative to its package, so it must not be bundled by webpack.
  serverExternalPackages: ["kokoro-js", "@huggingface/transformers", "onnxruntime-node", "phonemizer"],
};

export default nextConfig;
