import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildGrokArgs } from '../../src/grok/args.js';
import type {
  GrokRunOptions,
  GrokRunParams,
  PromptDelivery,
  SessionSelector,
} from '../../src/grok/args.js';
import { PERMISSION_LEVELS, permissionFlags } from '../../src/permission.js';
import type { PermissionLevel } from '../../src/permission.js';

/**
 * Overrides are typed against the options half only. The prompt half is a union — inline `-p`
 * or `--prompt-file`, never both — and `Partial` of a union collapses it into a shape that
 * permits exactly the pair the union exists to forbid.
 */
function minimal(overrides: Partial<GrokRunOptions> & Partial<PromptDelivery> = {}): GrokRunParams {
  const { prompt, promptFile, ...options } = overrides;
  const base = { outputFormat: 'json', permission: permissionFlags('read-only') } as const;
  if (promptFile !== undefined) {
    return { promptFile, ...base, ...options };
  }
  return { prompt: prompt ?? 'hello', ...base, ...options };
}

function assertAdjacent(argv: readonly string[], flag: string, value: string): void {
  const index = argv.indexOf(flag);
  assert.notEqual(index, -1, `missing ${flag} in ${JSON.stringify(argv)}`);
  assert.equal(
    argv[index + 1],
    value,
    `expected ${flag} to be followed by ${JSON.stringify(value)}, got ${JSON.stringify(argv[index + 1])}`,
  );
}

function assertSequence(argv: readonly string[], sequence: readonly string[]): void {
  const start = sequence[0];
  assert.ok(start, 'sequence must not be empty');
  const index = argv.indexOf(start);
  assert.notEqual(index, -1, `missing ${start} in ${JSON.stringify(argv)}`);
  assert.deepEqual(argv.slice(index, index + sequence.length), [...sequence]);
}

describe('buildGrokArgs minimal run', () => {
  it('emits the full argv for a read-only headless run, so a spelling or order regression is visible', () => {
    assert.deepEqual(
      [...buildGrokArgs(minimal({ prompt: 'OK' }))],
      [
        '-p',
        'OK',
        '--output-format',
        'json',
        '--permission-mode',
        'plan',
        '--sandbox',
        'read-only',
      ],
    );
  });

  it('puts -p first, because that is what triggers headless mode', () => {
    const argv = buildGrokArgs(minimal());
    assert.equal(argv[0], '-p');
    assert.equal(argv[1], 'hello');
  });

  it('always emits --output-format and never emits plain, because structured output is the only internal path', () => {
    const json = buildGrokArgs(minimal({ outputFormat: 'json' }));
    const streaming = buildGrokArgs(minimal({ outputFormat: 'streaming-json' }));
    assertAdjacent(json, '--output-format', 'json');
    assertAdjacent(streaming, '--output-format', 'streaming-json');
    assert.ok(!json.includes('plain'));
    assert.ok(!streaming.includes('plain'));
  });
});

describe('buildGrokArgs flag emission', () => {
  it('emits --cwd adjacent to the directory so the child starts in the requested tree', () => {
    assertAdjacent(buildGrokArgs(minimal({ cwd: '/tmp/proj' })), '--cwd', '/tmp/proj');
  });

  it('emits --model in long form, not -m, so a short-flag rename cannot silently land', () => {
    const argv = buildGrokArgs(minimal({ model: 'grok-4.6' }));
    assertAdjacent(argv, '--model', 'grok-4.6');
    assert.ok(!argv.includes('-m'));
  });

  it('emits --effort, the documented alias of --reasoning-effort', () => {
    const argv = buildGrokArgs(minimal({ effort: 'high' }));
    assertAdjacent(argv, '--effort', 'high');
    assert.ok(!argv.includes('--reasoning-effort'));
  });

  it('emits --permission-mode adjacent to the resolved mode', () => {
    assertAdjacent(
      buildGrokArgs(minimal({ permission: permissionFlags('write') })),
      '--permission-mode',
      'acceptEdits',
    );
  });

  it('emits --sandbox adjacent to the resolved profile', () => {
    assertAdjacent(
      buildGrokArgs(minimal({ permission: permissionFlags('write') })),
      '--sandbox',
      'workspace',
    );
  });

  it('emits --always-approve as a bare flag only when the permission says so', () => {
    const argv = buildGrokArgs(minimal({ permission: permissionFlags('full') }));
    assert.ok(argv.includes('--always-approve'));
    assert.notEqual(argv[argv.indexOf('--always-approve') + 1], 'true');
  });

  it('emits --max-turns adjacent to the turn cap as a decimal string', () => {
    assertAdjacent(buildGrokArgs(minimal({ maxTurns: 4 })), '--max-turns', '4');
  });

  it('emits --tools as a single comma-joined flag, not one flag per tool', () => {
    const argv = buildGrokArgs(minimal({ tools: ['read', 'search', 'run_terminal_command'] }));
    assertAdjacent(argv, '--tools', 'read,search,run_terminal_command');
    assert.equal(argv.filter((part) => part === '--tools').length, 1);
  });

  it('emits --disallowed-tools as a single comma-joined flag', () => {
    assertAdjacent(
      buildGrokArgs(minimal({ disallowedTools: ['run_terminal_command', 'write'] })),
      '--disallowed-tools',
      'run_terminal_command,write',
    );
  });

  it('repeats --allow once per rule and preserves rule order, because the CLI is one-rule-per-flag', () => {
    const argv = buildGrokArgs(minimal({ allow: ['Bash(npm*)', 'Write(src/**)'] }));
    assertSequence(argv, ['--allow', 'Bash(npm*)', '--allow', 'Write(src/**)']);
  });

  it('repeats --deny once per rule and preserves rule order', () => {
    const argv = buildGrokArgs(minimal({ deny: ['Read(.env)', 'Bash(rm*)'] }));
    assertSequence(argv, ['--deny', 'Read(.env)', '--deny', 'Bash(rm*)']);
  });

  it('emits --rules adjacent to the extra system-prompt text', () => {
    assertAdjacent(buildGrokArgs(minimal({ rules: 'be careful' })), '--rules', 'be careful');
  });

  it('emits --agent adjacent to the agent name', () => {
    assertAdjacent(buildGrokArgs(minimal({ agent: 'reviewer' })), '--agent', 'reviewer');
  });

  it('emits --json-schema adjacent to the schema string', () => {
    const schema = '{"type":"object"}';
    assertAdjacent(buildGrokArgs(minimal({ jsonSchema: schema })), '--json-schema', schema);
  });

  it('emits --disable-web-search as a bare flag only when true', () => {
    const argv = buildGrokArgs(minimal({ disableWebSearch: true }));
    assert.ok(argv.includes('--disable-web-search'));
    assert.ok(
      !buildGrokArgs(minimal({ disableWebSearch: false })).includes('--disable-web-search'),
    );
  });
});

describe('buildGrokArgs omitted values', () => {
  const stringCases: readonly {
    label: string;
    overrides: Partial<GrokRunParams>;
    flag: string;
  }[] = [
    { label: 'undefined cwd', overrides: { cwd: undefined }, flag: '--cwd' },
    { label: 'empty-string cwd', overrides: { cwd: '' }, flag: '--cwd' },
    { label: 'undefined model', overrides: { model: undefined }, flag: '--model' },
    { label: 'null model', overrides: { model: null }, flag: '--model' },
    { label: 'empty-string model', overrides: { model: '' }, flag: '--model' },
    { label: 'undefined effort', overrides: { effort: undefined }, flag: '--effort' },
    { label: 'null effort', overrides: { effort: null }, flag: '--effort' },
    { label: 'empty-string effort', overrides: { effort: '' }, flag: '--effort' },
    { label: 'undefined rules', overrides: { rules: undefined }, flag: '--rules' },
    { label: 'empty-string rules', overrides: { rules: '' }, flag: '--rules' },
    { label: 'undefined agent', overrides: { agent: undefined }, flag: '--agent' },
    { label: 'empty-string agent', overrides: { agent: '' }, flag: '--agent' },
    { label: 'undefined jsonSchema', overrides: { jsonSchema: undefined }, flag: '--json-schema' },
    { label: 'empty-string jsonSchema', overrides: { jsonSchema: '' }, flag: '--json-schema' },
  ];

  for (const { label, overrides, flag } of stringCases) {
    it(`omits ${flag} when the value is ${label}, because an empty value is not a request`, () => {
      assert.ok(!buildGrokArgs(minimal(overrides)).includes(flag));
    });
  }

  it('omits --max-turns when the cap is undefined', () => {
    assert.ok(!buildGrokArgs(minimal({ maxTurns: undefined })).includes('--max-turns'));
  });

  it('omits --tools when the list is undefined or empty, so we never emit --tools with no value', () => {
    assert.ok(!buildGrokArgs(minimal({ tools: undefined })).includes('--tools'));
    assert.ok(!buildGrokArgs(minimal({ tools: [] })).includes('--tools'));
  });

  it('omits --disallowed-tools when the list is undefined or empty', () => {
    assert.ok(
      !buildGrokArgs(minimal({ disallowedTools: undefined })).includes('--disallowed-tools'),
    );
    assert.ok(!buildGrokArgs(minimal({ disallowedTools: [] })).includes('--disallowed-tools'));
  });

  it('omits --allow when the list is undefined or empty', () => {
    assert.ok(!buildGrokArgs(minimal({ allow: undefined })).includes('--allow'));
    assert.ok(!buildGrokArgs(minimal({ allow: [] })).includes('--allow'));
  });

  it('omits --deny when the list is undefined or empty', () => {
    assert.ok(!buildGrokArgs(minimal({ deny: undefined })).includes('--deny'));
    assert.ok(!buildGrokArgs(minimal({ deny: [] })).includes('--deny'));
  });

  it('omits --disable-web-search when the flag is undefined or false, because false is not a request', () => {
    assert.ok(
      !buildGrokArgs(minimal({ disableWebSearch: undefined })).includes('--disable-web-search'),
    );
    assert.ok(
      !buildGrokArgs(minimal({ disableWebSearch: false })).includes('--disable-web-search'),
    );
  });

  it('omits session flags when the selector is omitted or new, because every grok -p already starts fresh', () => {
    const omitted = buildGrokArgs(minimal({ session: undefined }));
    const fresh = buildGrokArgs(minimal({ session: { kind: 'new' } }));
    for (const argv of [omitted, fresh]) {
      assert.ok(!argv.includes('--session-id'));
      assert.ok(!argv.includes('--resume'));
      assert.ok(!argv.includes('--continue'));
      assert.ok(!argv.includes('--fork-session'));
    }
  });
});

describe('buildGrokArgs session selectors', () => {
  it('emits --session-id for new-with-id so the caller can name the session Grok will create', () => {
    const argv = buildGrokArgs(
      minimal({ session: { kind: 'new-with-id', id: '01a00a41-8f57-7de2-bb03-caccc61a1f0e' } }),
    );
    assertAdjacent(argv, '--session-id', '01a00a41-8f57-7de2-bb03-caccc61a1f0e');
    assert.ok(!argv.includes('--resume'));
    assert.ok(!argv.includes('--continue'));
    assert.ok(!argv.includes('-s'));
  });

  it('emits --resume without a value when resuming the most recent session', () => {
    const argv = buildGrokArgs(minimal({ session: { kind: 'resume' } }));
    assert.ok(argv.includes('--resume'));
    assert.ok(!argv.includes('-r'));
    const next = argv[argv.indexOf('--resume') + 1];
    assert.ok(next === undefined || next.startsWith('--'));
  });

  it('emits --resume and the id as adjacent argv elements, because the flag takes an optional value', () => {
    const argv = buildGrokArgs(minimal({ session: { kind: 'resume', id: 'sess-1' } }));
    assertAdjacent(argv, '--resume', 'sess-1');
  });

  it('adds --fork-session --session-id when resume carries a forkId, so the fork is a new named session', () => {
    const argv = buildGrokArgs(
      minimal({ session: { kind: 'resume', id: 'sess-1', forkId: 'fork-9' } }),
    );
    assertAdjacent(argv, '--resume', 'sess-1');
    assertSequence(argv, ['--fork-session', '--session-id', 'fork-9']);
  });

  it('emits --resume --fork-session --session-id when resuming the latest session into a named fork', () => {
    const argv = buildGrokArgs(minimal({ session: { kind: 'resume', forkId: 'fork-9' } }));
    assert.ok(argv.includes('--resume'));
    assert.notEqual(argv[argv.indexOf('--resume') + 1], 'fork-9');
    assertSequence(argv, ['--fork-session', '--session-id', 'fork-9']);
  });

  it('emits --continue for the most recent session in cwd', () => {
    const argv = buildGrokArgs(minimal({ session: { kind: 'continue' } }));
    assert.ok(argv.includes('--continue'));
    assert.ok(!argv.includes('-c'));
    assert.ok(!argv.includes('--resume'));
  });

  it('adds --fork-session --session-id when continue carries a forkId', () => {
    const argv = buildGrokArgs(minimal({ session: { kind: 'continue', forkId: 'fork-2' } }));
    assert.ok(argv.includes('--continue'));
    assertSequence(argv, ['--fork-session', '--session-id', 'fork-2']);
  });

  it('omits a fork when forkId is empty, because an empty id is not a request to name the fork', () => {
    const resume: SessionSelector = { kind: 'resume', id: 'sess-1', forkId: '' };
    const cont: SessionSelector = { kind: 'continue', forkId: '' };
    assert.ok(!buildGrokArgs(minimal({ session: resume })).includes('--fork-session'));
    assert.ok(!buildGrokArgs(minimal({ session: cont })).includes('--fork-session'));
  });

  it('fails closed on an unhandled session kind so a new variant cannot silently emit nothing', () => {
    const session = { kind: 'import' } as unknown as SessionSelector;
    assert.throws(() => buildGrokArgs(minimal({ session })), /unhandled session selector/);
  });
});

describe('buildGrokArgs permission levels', () => {
  const expected: Record<
    PermissionLevel,
    { permissionMode: string; sandbox: string; alwaysApprove: boolean }
  > = {
    'read-only': { permissionMode: 'plan', sandbox: 'read-only', alwaysApprove: false },
    write: { permissionMode: 'acceptEdits', sandbox: 'workspace', alwaysApprove: false },
    full: { permissionMode: 'bypassPermissions', sandbox: 'off', alwaysApprove: true },
  };

  for (const level of PERMISSION_LEVELS) {
    it(`maps ${level} to the documented --permission-mode / --sandbox pair`, () => {
      const argv = buildGrokArgs(minimal({ permission: permissionFlags(level) }));
      const flags = expected[level];
      assertAdjacent(argv, '--permission-mode', flags.permissionMode);
      assertAdjacent(argv, '--sandbox', flags.sandbox);
      assert.equal(argv.includes('--always-approve'), flags.alwaysApprove);
    });
  }

  it('emits --permission-mode and --sandbox even when the flag values are empty, because falling back to the CLI default is a silent downgrade', () => {
    const argv = buildGrokArgs(
      minimal({ permission: { permissionMode: '', sandbox: '', alwaysApprove: false } }),
    );
    assertAdjacent(argv, '--permission-mode', '');
    assertAdjacent(argv, '--sandbox', '');
  });

  it('emits --always-approve only at full, because --yolo is documented but absent from grok --help', () => {
    const approving = PERMISSION_LEVELS.filter((level) =>
      buildGrokArgs(minimal({ permission: permissionFlags(level) })).includes('--always-approve'),
    );
    assert.deepEqual(approving, ['full']);
  });
});

describe('buildGrokArgs prompt fidelity', () => {
  it('passes a prompt with quotes, a newline, $HOME, a backtick, and a leading dash through unchanged, because spawn receives the array verbatim', () => {
    const prompt = '"double" \'single\'\n$HOME `whoami` -dashed';
    const argv = buildGrokArgs(minimal({ prompt }));
    assert.equal(argv[0], '-p');
    assert.equal(argv[1], prompt);
    assert.equal(argv[1], '"double" \'single\'\n$HOME `whoami` -dashed');
  });
});

describe('buildGrokArgs immutability and order', () => {
  it('returns a frozen array so a later caller cannot rewrite the spawn arguments', () => {
    const argv = buildGrokArgs(minimal());
    assert.ok(Object.isFrozen(argv));
    assert.throws(() => {
      (argv as string[]).push('--oops');
    }, TypeError);
  });

  it('emits a fully-specified run in the documented order so a missing or reordered flag is a test failure', () => {
    const argv = buildGrokArgs(
      minimal({
        prompt: 'do the thing',
        outputFormat: 'streaming-json',
        permission: permissionFlags('full'),
        cwd: '/tmp/work',
        model: 'grok-4.6',
        effort: 'high',
        maxTurns: 4,
        tools: ['read', 'search'],
        disallowedTools: ['run_terminal_command'],
        allow: ['Read(src/**)', 'Write(src/**)'],
        deny: ['Bash(rm*)'],
        rules: 'be careful',
        agent: 'reviewer',
        jsonSchema: '{"type":"object"}',
        session: { kind: 'resume', id: 'abc', forkId: 'def' },
        disableWebSearch: true,
      }),
    );

    assert.deepEqual(
      [...argv],
      [
        '-p',
        'do the thing',
        '--output-format',
        'streaming-json',
        '--cwd',
        '/tmp/work',
        '--model',
        'grok-4.6',
        '--effort',
        'high',
        '--permission-mode',
        'bypassPermissions',
        '--sandbox',
        'off',
        '--always-approve',
        '--max-turns',
        '4',
        '--tools',
        'read,search',
        '--disallowed-tools',
        'run_terminal_command',
        '--allow',
        'Read(src/**)',
        '--allow',
        'Write(src/**)',
        '--deny',
        'Bash(rm*)',
        '--rules',
        'be careful',
        '--agent',
        'reviewer',
        '--json-schema',
        '{"type":"object"}',
        '--resume',
        'abc',
        '--fork-session',
        '--session-id',
        'def',
        '--disable-web-search',
      ],
    );
  });
});
