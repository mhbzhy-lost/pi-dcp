import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerPiDcp } from "./src/extension.ts";

export default function piDcpExtension(pi: ExtensionAPI): void {
  registerPiDcp(pi);
}
