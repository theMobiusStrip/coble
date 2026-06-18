import { existsSync, readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { PERMISSION_MODES, type PermissionMode } from "./approval.js";
import { compileRuleList, type CompiledRules } from "./permissionRules.js";
import { globalSettingsPath, projectSettingsPath } from "./store.js";

/**
 * Layered permission settings loaded from YAML:
 *   ~/.coble/settings.yaml   (global — trusted; may grant allow / auto / bypass)
 *   <cwd>/.coble/settings.yaml (project — UNTRUSTED; may only tighten)
 *
 * SECURITY INVARIANT: a project file ships inside the repo under work, so it must
 * not be able to self-escalate. Project scope contributes only `deny` and `ask`;
 * its `allow`, `defaultMode`, and `autoMode.model` are ignored. Mirrors Claude
 * Code's "a repo cannot grant itself auto/bypass".
 */

const PermissionsSchema = z.object({
  defaultMode: z.enum(PERMISSION_MODES).optional(),
  allow: z.array(z.string()).optional(),
  ask: z.array(z.string()).optional(),
  deny: z.array(z.string()).optional(),
  autoMode: z.object({ model: z.string().optional() }).optional(),
});
type RawPermissions = z.infer<typeof PermissionsSchema>;

const FileSchema = z.object({ permissions: PermissionsSchema.optional() });

export interface LoadedSettings {
  /** Global default mode (project cannot set this). */
  defaultMode?: PermissionMode;
  /** Compiled allow/ask/deny rules (allow = global only; deny/ask = global+project). */
  rules: CompiledRules;
  /** Classifier model spec for auto mode (global only). */
  autoModel?: string;
}

function readSettingsFile(
  path: string,
  onWarn: (m: string) => void,
): RawPermissions | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const parsed = FileSchema.safeParse(parseYaml(readFileSync(path, "utf8")) ?? {});
    if (!parsed.success) {
      onWarn(`ignoring ${path}: ${parsed.error.issues[0]?.message ?? "invalid settings"}`);
      return undefined;
    }
    return parsed.data.permissions;
  } catch (err) {
    onWarn(`ignoring ${path}: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

export function loadSettings(opts: { cwd: string; onWarn?: (m: string) => void }): LoadedSettings {
  const warn = opts.onWarn ?? (() => {});
  const global = readSettingsFile(globalSettingsPath(), warn);
  const project = readSettingsFile(projectSettingsPath(opts.cwd), warn);

  if (project && (project.allow?.length || project.defaultMode || project.autoMode?.model)) {
    warn(
      "project .coble/settings.yaml: allow/defaultMode/autoMode are ignored — project scope can only tighten (deny/ask)",
    );
  }

  const rules: CompiledRules = {
    allow: compileRuleList(global?.allow ?? [], true), // grants are case-sensitive (a grant must not widen to a case-variant)
    ask: [...compileRuleList(global?.ask ?? []), ...compileRuleList(project?.ask ?? [])],
    deny: [...compileRuleList(global?.deny ?? []), ...compileRuleList(project?.deny ?? [])],
  };

  return { defaultMode: global?.defaultMode, rules, autoModel: global?.autoMode?.model };
}
