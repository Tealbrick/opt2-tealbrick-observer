// The manifest, read once. It is the only description of the app (the SDK derives everything from it).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AppDefinition } from "@opt2-tealbrick/miniapp-sdk";

export const manifest = JSON.parse(readFileSync(new URL("../tealbrick.manifest.json", import.meta.url), "utf8")) as AppDefinition["manifest"];
export const migrationsDir = fileURLToPath(new URL("../migrations", import.meta.url));
