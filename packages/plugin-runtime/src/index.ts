import { createHash } from "node:crypto"
export interface LocalPluginManifest { readonly id: string; readonly version: string; readonly entry: string; readonly permissions: readonly string[] }
const TOKEN = /^[a-z0-9][a-z0-9-]{0,63}$/

export function validateLocalPlugin(value: unknown): LocalPluginManifest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("plugin_manifest_invalid")
  const item = value as Record<string, unknown>
  if (Object.keys(item).some((key) => !["id", "version", "entry", "permissions"].includes(key))) throw new Error("plugin_manifest_unknown_field")
  if (typeof item.id !== "string" || !TOKEN.test(item.id)) throw new Error("plugin_id_invalid")
  if (typeof item.version !== "string" || !/^\d+\.\d+\.\d+$/.test(item.version)) throw new Error("plugin_version_invalid")
  if (typeof item.entry !== "string" || item.entry.startsWith("/") || item.entry.includes("..") || /^[a-z]+:/i.test(item.entry)) throw new Error("plugin_entry_must_be_local")
  if (!Array.isArray(item.permissions) || !item.permissions.every((permission) => typeof permission === "string" && TOKEN.test(permission))) throw new Error("plugin_permissions_invalid")
  return Object.freeze({ id: item.id, version: item.version, entry: item.entry, permissions: Object.freeze([...item.permissions]) })
}

export const localPluginDigest = (manifest: LocalPluginManifest): string => createHash("sha256").update(JSON.stringify(manifest)).digest("hex")
