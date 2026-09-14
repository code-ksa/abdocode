import { isAbsolute, resolve } from "node:path"
export interface PublicProjectConfig { readonly version: 1; readonly projectDirectory: string; readonly network: "off" | "allowlisted" }

export function loadPublicProjectConfig(value: unknown, trusted: boolean, baseDirectory: string): PublicProjectConfig {
  if (!trusted) throw new Error("project_config_requires_trust")
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("project_config_invalid")
  const item = value as Record<string, unknown>
  if (Object.keys(item).some((key) => !["version", "projectDirectory", "network"].includes(key))) throw new Error("project_config_unknown_field")
  if (item.version !== 1 || typeof item.projectDirectory !== "string" || item.projectDirectory.length === 0) throw new Error("project_config_invalid")
  if (item.network !== "off" && item.network !== "allowlisted") throw new Error("project_network_policy_invalid")
  const projectDirectory = isAbsolute(item.projectDirectory) ? resolve(item.projectDirectory) : resolve(baseDirectory, item.projectDirectory)
  return Object.freeze({ version: 1, projectDirectory, network: item.network })
}
