import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

function sha256File(path) {
  return "0x" + createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function buildManifest({ model, promptFile, inputFiles, outputFile, created }) {
  if (!model) throw new Error("--model is required");
  if (!promptFile) throw new Error("--prompt is required");
  if (!inputFiles || (Array.isArray(inputFiles) && inputFiles.length === 0)) throw new Error("--input is required");
  if (!outputFile) throw new Error("--output is required");
  if (!created) throw new Error("--created is required");

  const inputs = Array.isArray(inputFiles) ? inputFiles : [inputFiles];
  const manifest = {
    created: String(created),
    input_documents_sha256: inputs.map((f) => sha256File(f)),
    model: String(model),
    output_sha256: sha256File(outputFile),
    prompt_sha256: sha256File(promptFile),
    reviewed_by: "human reviewer (wallet signs below)",
    schema: "buildproof.ai-output/v1",
  };

  return JSON.stringify(manifest);
}
