// Ordered access rules shared by the web routes, the listeners and the forward
// rules. Each list is evaluated top to bottom and the first entry that matches
// decides; `rest` is the pinned "everything else" row at the end.
export type AccessAction = 'allow' | 'deny'
export type AccessKind = 'ip' | 'geo' | 'ua'
export type AccessMode = 'off' | 'rules' | 'inherit'

export interface AccessEntry {
  action: AccessAction
  kind: AccessKind
  value: string
}

export interface AccessList {
  entries: AccessEntry[]
  rest: AccessAction
}

export interface Access {
  mode: AccessMode
  ip: AccessList
  ua: AccessList
}

export function emptyAccess(): Access {
  return { mode: 'off', ip: { entries: [], rest: 'deny' }, ua: { entries: [], rest: 'allow' } }
}

function normalizeList(input: any, ua: boolean, keepEmpty: boolean): AccessList {
  const entries: AccessEntry[] = Array.isArray(input?.entries)
    ? input.entries
        .map((entry: any) => ({
          action: entry?.action === 'deny' ? ('deny' as const) : ('allow' as const),
          kind: ua ? ('ua' as const) : entry?.kind === 'geo' ? ('geo' as const) : ('ip' as const),
          value: String(entry?.value ?? '').trim(),
        }))
        // A row the operator is still typing has no value yet; the editor keeps
        // it so the row does not vanish under the cursor, the form drops it on
        // the way out.
        .filter((entry: AccessEntry) => keepEmpty || entry.value !== '')
    : []
  return { entries, rest: input?.rest === 'allow' ? 'allow' : 'deny' }
}

export function normalizeAccess(input: any, options: { keepEmpty?: boolean } = {}): Access {
  const mode: AccessMode =
    input?.mode === 'rules' || input?.mode === 'inherit' ? input.mode : 'off'
  const keepEmpty = options.keepEmpty === true
  return {
    mode,
    ip: normalizeList(input?.ip, false, keepEmpty),
    ua: normalizeList(input?.ua, true, keepEmpty),
  }
}

/** "规则 3 条 · 其余拦截" summary used by the list rows. */
export function accessSummary(access?: Access | null): string {
  if (!access || access.mode === 'off') return '关闭'
  if (access.mode === 'inherit') return '继承监听器'
  const count = access.ip?.entries?.length ?? 0
  return `规则 ${count} 条 · 其余${access.ip?.rest === 'allow' ? '通过' : '拦截'}`
}
