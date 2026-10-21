// SPDX-License-Identifier: AGPL-3.0-or-later
/** Shell completion (bash, zsh, fish) generated from built-in commands + the action catalog. */
import { type Catalog, GLOBAL_FLAGS, actionFields, commandPath, groups } from '../catalog.ts';

export interface CompletionFlag {
  name: string;
  description?: string;
  takesValue: boolean;
  values?: string[];
}

export interface CompletionNode {
  name: string;
  description: string;
  children?: CompletionNode[];
  flags?: CompletionFlag[];
}

/** Built-in (non-generated) commands with their subcommands. */
export const BUILTIN_TREE: CompletionNode[] = [
  { name: 'serve', description: 'Run the server' },
  {
    name: 'init',
    description: 'Create beamhop.yaml (3 questions)',
    flags: [
      { name: 'domain', takesValue: true },
      {
        name: 'persona',
        takesValue: true,
        values: ['public-social', 'private-team', 'wot-community', 'media-host', 'organization'],
      },
      { name: 'storage', takesValue: true, values: ['sqlite', 'postgres', 'memory'] },
      { name: 'force', takesValue: false },
      { name: 'output', takesValue: true },
    ],
  },
  {
    name: 'login',
    description: 'Sign in to a server and save an API token',
    flags: ['bunker', 'claim-code', 'invite-code', 'name', 'days']
      .map((name) => ({ name, takesValue: true }))
      .concat(['nsec-stdin', 'print-token'].map((name) => ({ name, takesValue: false }))),
  },
  { name: 'logout', description: 'Forget a saved login' },
  { name: 'status', description: 'Health score and what needs attention' },
  {
    name: 'config',
    description: 'Settings: export, import, diff, history, restore',
    children: ['export', 'import', 'diff', 'history', 'restore'].map((name) => ({
      name,
      description: `config ${name}`,
    })),
  },
  {
    name: 'backup',
    description: 'Back up and restore',
    children: ['now', 'list', 'restore'].map((name) => ({ name, description: `backup ${name}` })),
  },
  {
    name: 'update',
    description: 'Update to the latest release',
    flags: [
      { name: 'check', takesValue: false },
      { name: 'force', takesValue: false },
      { name: 'manifest', takesValue: true },
    ],
  },
  { name: 'rollback', description: 'Go back to the previous version' },
  { name: 'claim-code', description: 'Show the one-time claim code' },
  {
    name: 'doctor',
    description: 'Check the setup and offer fixes',
    flags: [{ name: 'fix', takesValue: false }],
  },
  {
    name: 'move',
    description: 'Move this relay to another server',
    children: ['export', 'import', 'verify'].map((name) => ({ name, description: `move ${name}` })),
  },
  { name: 'undo', description: 'Undo a recent change' },
  { name: 'actions', description: 'List everything you can do' },
  {
    name: 'completion',
    description: 'Shell completion script',
    children: ['bash', 'zsh', 'fish'].map((name) => ({ name, description: `${name} completion` })),
  },
  { name: 'help', description: 'Show help' },
];

export function completionTree(catalog: Catalog | null): CompletionNode[] {
  const tree = BUILTIN_TREE.map((n) => ({ ...n }));
  if (!catalog) return tree;
  const builtinNames = new Set(tree.map((n) => n.name));
  for (const [group, entries] of groups(catalog)) {
    const children = entries.map<CompletionNode>((e) => ({
      name: commandPath(e.id).slice(1).join(' '),
      description: e.title,
      flags: actionFields(e).map((f) => {
        const flag: CompletionFlag = { name: f.flag, takesValue: f.type !== 'boolean' };
        if (f.description) flag.description = f.description;
        const values = f.enum ?? f.itemEnum;
        if (values) flag.values = values.map(String);
        return flag;
      }),
    }));
    if (builtinNames.has(group)) {
      // An action group sharing a built-in name (e.g. `config`) adds its subcommands.
      const node = tree.find((n) => n.name === group)!;
      node.children = [...(node.children ?? []), ...children];
    } else {
      tree.push({ name: group, description: `${entries.length} action(s)`, children });
    }
  }
  return tree;
}

const globalFlags: CompletionFlag[] = GLOBAL_FLAGS.map((f) => ({
  name: f.name,
  takesValue: f.type === 'string',
  ...(f.description ? { description: f.description } : {}),
}));

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export function bashCompletion(tree: CompletionNode[]): string {
  const cases: string[] = [];
  const enumCases: string[] = [];
  const valueFlags = new Set(globalFlags.filter((f) => f.takesValue).map((f) => `--${f.name}`));
  const top = tree.map((n) => n.name).join(' ');
  const gflags = globalFlags.map((f) => `--${f.name}`).join(' ');
  for (const n of tree) {
    const subs = (n.children ?? []).map((c) => c.name.split(' ')[0]);
    const flags = (n.flags ?? []).map((f) => `--${f.name}`);
    cases.push(`    ${shq(n.name)}) words_=${shq([...new Set(subs), ...flags].join(' '))};;`);
    for (const f of n.flags ?? []) {
      if (f.takesValue) valueFlags.add(`--${f.name}`);
      if (f.values)
        enumCases.push(`    ${shq(`${n.name}|--${f.name}`)}) words_=${shq(f.values.join(' '))};;`);
    }
    for (const c of n.children ?? []) {
      const key = `${n.name} ${c.name}`;
      cases.push(
        `    ${shq(key)}) words_=${shq((c.flags ?? []).map((f) => `--${f.name}`).join(' '))};;`,
      );
      for (const f of c.flags ?? []) {
        if (f.takesValue) valueFlags.add(`--${f.name}`);
        if (f.values)
          enumCases.push(`    ${shq(`${key}|--${f.name}`)}) words_=${shq(f.values.join(' '))};;`);
      }
    }
  }
  return `# beamhop bash completion (generated by \`beamhop completion bash\`)
_beamhop() {
  local cur prev key words_ i w n=0
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"
  key=""
  for ((i = 1; i < COMP_CWORD; i++)); do
    w="\${COMP_WORDS[i]}"
    case "$w" in
      -*) case " ${[...valueFlags].join(' ')} " in *" $w "*) ((i++));; esac;;
      *) if ((n < 3)); then key="\${key:+$key }$w"; ((n++)); fi;;
    esac
  done
  words_=""
  case "$key|$prev" in
${enumCases.join('\n')}
  esac
  if [[ -n "$words_" ]]; then COMPREPLY=($(compgen -W "$words_" -- "$cur")); return; fi
  if [[ -z "$key" ]]; then
    words_=${shq(top)}
  else
    case "$key" in
${cases.join('\n')}
    esac
  fi
  if [[ "$cur" == -* ]]; then words_="$words_ ${gflags}"; fi
  COMPREPLY=($(compgen -W "$words_" -- "$cur"))
}
complete -F _beamhop beamhop
`;
}

export function zshCompletion(tree: CompletionNode[]): string {
  return `#compdef beamhop
# beamhop zsh completion (generated by \`beamhop completion zsh\`)
autoload -U +X bashcompinit && bashcompinit
${bashCompletion(tree).split('\n').slice(1).join('\n')}`;
}

const fishq = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

export function fishCompletion(tree: CompletionNode[]): string {
  const out = [
    '# beamhop fish completion (generated by `beamhop completion fish`)',
    'complete -c beamhop -f',
  ];
  const topNames = tree.map((n) => n.name).join(' ');
  for (const f of globalFlags)
    out.push(
      `complete -c beamhop -l ${f.name}${f.takesValue ? ' -r' : ''}${f.description ? ` -d ${fishq(f.description)}` : ''}`,
    );
  const flagLine = (cond: string, f: CompletionFlag) =>
    `complete -c beamhop -n ${fishq(cond)} -l ${f.name}${f.takesValue ? ' -r' : ''}${
      f.values ? ` -a ${fishq(f.values.join(' '))}` : ''
    }${f.description ? ` -d ${fishq(f.description)}` : ''}`;
  for (const n of tree) {
    out.push(
      `complete -c beamhop -n ${fishq(`not __fish_seen_subcommand_from ${topNames}`)} -a ${n.name} -d ${fishq(n.description)}`,
    );
    for (const f of n.flags ?? []) out.push(flagLine(`__fish_seen_subcommand_from ${n.name}`, f));
    const subNames = (n.children ?? []).map((c) => c.name.split(' ')[0]).join(' ');
    for (const c of n.children ?? []) {
      const first = c.name.split(' ')[0]!;
      out.push(
        `complete -c beamhop -n ${fishq(`__fish_seen_subcommand_from ${n.name}; and not __fish_seen_subcommand_from ${subNames}`)} -a ${first} -d ${fishq(c.description)}`,
      );
      for (const f of c.flags ?? [])
        out.push(
          flagLine(
            `__fish_seen_subcommand_from ${n.name}; and __fish_seen_subcommand_from ${first}`,
            f,
          ),
        );
    }
  }
  return `${out.join('\n')}\n`;
}

export function completionScript(shell: string, catalog: Catalog | null): string | null {
  const tree = completionTree(catalog);
  if (shell === 'bash') return bashCompletion(tree);
  if (shell === 'zsh') return zshCompletion(tree);
  if (shell === 'fish') return fishCompletion(tree);
  return null;
}
