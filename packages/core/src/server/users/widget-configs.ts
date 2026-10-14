import type { z } from 'zod';
import type { ContractShape } from '@petalbot/sdk';
import type { PresetInput } from './schemas.ts';

/** `plugin\0widget\0config` of a stored instance, to recognize configs a save leaves unchanged. */
const fingerprint = (entry: PresetInput['columns'][number]['widgets'][number]): string =>
  `${entry.plugin}\0${entry.widget}\0${JSON.stringify(entry.config ?? null)}`;

/**
 * Validates every widget config against its widget's schema, for plugins whose contract is known
 * (cached by the plugin manager). Unknown plugins and widgets keep their config as it is.
 * Configs the save leaves unchanged (same instance id, widget and config as in `previous`) are
 * accepted as they are: a plugin update may have made them invalid, and that must not block
 * saving the rest of the preset (the panel shows them as "Needs configuration").
 * Issue paths start at the preset root: columns.<i>.widgets.<j>.config.<field>.
 */
export function widgetConfigIssues(
  contractOf: (pluginId: string) => ContractShape | undefined,
  input: PresetInput,
  previous?: PresetInput,
): z.core.$ZodIssue[] {
  const stored = new Map(
    (previous?.columns ?? []).flatMap((column) =>
      column.widgets.map((entry) => [entry.id, fingerprint(entry)] as const),
    ),
  );
  const issues: z.core.$ZodIssue[] = [];
  input.columns.forEach((column, columnIndex) => {
    column.widgets.forEach((entry, widgetIndex) => {
      if (stored.get(entry.id) === fingerprint(entry)) return;
      const widgets = contractOf(entry.plugin)?.widgets ?? {};
      const schema = Object.hasOwn(widgets, entry.widget)
        ? widgets[entry.widget]?.config
        : undefined;
      if (!schema) return;
      const result = schema.safeParse(entry.config ?? {});
      if (result.success) return;
      for (const issue of result.error.issues) {
        issues.push({
          ...issue,
          path: ['columns', columnIndex, 'widgets', widgetIndex, 'config', ...issue.path],
        });
      }
    });
  });
  return issues;
}
