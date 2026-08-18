# Element Arena — terminal client

Play a 3v3 Element Arena match against the built-in AI, straight in your terminal.
Runs the engine natively via Node's TypeScript type-stripping — **no build step**.

## Play

```bash
node game/client/cli.ts                    # default preset, you = Team A vs the AI
node game/client/cli.ts a,b,c x,y,z 42     # custom draft (hero ids) + seed
node game/client/cli.ts --you=B            # control Team B instead
node game/client/cli.ts --demo             # AI vs AI (non-interactive)
```

Needs Node 24+ (for native `.ts` execution). `NO_COLOR=1` disables ANSI colour.

On your turn the board shows both teams (HP bars, shields, energy, statuses); for
each of your living units you pick a skill by number (`0` to hold), then a target
if the skill needs one. Unusable skills (on cooldown, unaffordable, stunned) are
dimmed. The AI opponent uses the engine's `defaultPolicy`. First to 2 rounds wins.

## Layout

- `render.ts` — pure string builders for the board / skills / log (no I/O; unit-tested).
- `loop.ts` — the async match loop: the engine's `playMatch` phase machine, but it
  *awaits* each team's actions so a human can be prompted mid-turn.
- `cli.ts` — the terminal entry point (stdin prompts, presets, arg parsing).

## Test / typecheck

```bash
node --test game/client/cli.test.ts
cd game/engine && npx tsc --noEmit -p ../client/tsconfig.json
```

## Not yet wired

The between-round **augment/fusion draft** is stubbed (each round starts fresh) —
that's the next increment. A graphical/web client can reuse `render.ts` + `loop.ts`.
