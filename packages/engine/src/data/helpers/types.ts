// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The SQL entrypoint every data helper takes. It is the call signature of the
 * agents SDK's `this.sql` tagged-template method (`agents@0.8.2`), NOT the
 * `SqlStorage.exec` API — the whole DO issues queries through `this.sql`, and
 * moving query bodies verbatim keeps the audit hot-path SQL text identical.
 * `UserAgent` binds it once (`this.sql.bind(this)`) and
 * passes it to helpers, so call sites never re-bind and can't hit a lost-`this`.
 */
export type EngineSql = <
  T = Record<string, string | number | boolean | null>,
>(
  strings: TemplateStringsArray,
  ...values: (string | number | boolean | null)[]
) => T[];
