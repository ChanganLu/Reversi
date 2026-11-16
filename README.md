# Reversi

A complete Reversi (Othello) game for the browser, with a Monte-Carlo tree search
engine running in a Web Worker and a second, deeper alpha-beta engine for the
endgame. No dependencies, no build step, no server: it is plain static files that
GitHub Pages can serve as-is.

**[Play it](https://changan-lu.github.io/Reversi/)** — or `npm start` for a local copy.

| | |
|---|---|
| **Board** | 8x8 Reversi with animated 3D disc flips, legal-move hints, last-move and suggestion markers |
| **Engines** | Monte-Carlo tree search (UCT, tree reuse) and iterative-deepening alpha-beta |
| **Threading** | The search runs in a Web Worker; the interface never blocks and stays at 60 fps |
| **Themes** | Paper (default, ivory and ink), Midnight (dark slate and teal), Felt (green baize and cream) — switchable at runtime and remembered between visits |
| **Modes** | Play black, play white, two players, or watch the engines play each other |
| **Extras** | Hint, undo, move history, resumable games (localStorage), keyboard play, deep links |

`npm run check` drives a headless browser over the page and writes screenshots to
`tools/shots/` (`01-paper`, `02-midnight`, `03-felt`, `04-mid-game`, `05-mobile`)
so the three themes and the phone layout can be reviewed without clicking through
the app.

---

## Quick start

```bash
# Any static file server works; ES modules and module workers need http(s).
npm start                # http://127.0.0.1:8080/
# or
python -m http.server 8080
```

Opening `index.html` straight from the filesystem will **not** work: browsers
refuse to load ES modules (and module workers) over `file://`.

### Deploying to GitHub Pages

1. Push the repository to GitHub.
2. *Settings → Pages → Source*: **GitHub Actions**.
3. The workflow in `.github/workflows/pages.yml` runs the test suite and publishes
   `index.html`, `assets/`, `css/` and `js/`. Nothing else is shipped.

Because the site is served from a subpath (`/Reversi/`), every path in the app is
relative — there is nothing to configure.

### Playing

| Action | Mouse | Keyboard |
|---|---|---|
| Place a disc | Click a highlighted square | Arrow keys / `WASD`, then `Enter` |
| Hint | *Hint* button | `H` |
| Take back | *Undo* button | `U` |
| New game | *New game* button | `N` |

Clicking a square always plays for whoever is on move, and the board is locked
while the engine is thinking. Undo takes back your move *and* the engine's reply,
so it always returns the turn to you.

### Deep links

The URL accepts `?theme=`, `?mode=`, `?engine=`, `?level=` and `?demo=N`, which is
handy for sharing a position or for screenshots:

```
/?theme=midnight&engine=ab&level=expert
/?demo=24                          # the demo position after 24 random plies
/?mode=cvc&level=medium            # watch the engines play
```

---

## How the AI works

Both engines share one rules core and one evaluator and run inside
`js/ai/worker.js`. The main thread sends a position and a time budget; the worker
answers with a move and telemetry. Cancellation is instant because the search loops
yield to the event loop between iterations (`js/ai/yield.js`).

### Board representation

A position is two 64-bit masks (own discs, opponent discs) stored as four `int32`
words, always from the point of view of the player to move. Move generation is the
classic parallel shift-and-mask walk, with the edge masks applied at *every* step.

| | array board (`rules.js`) | bitboards (`bitboard.js`) |
|---|---|---|
| move generation | ~290k / s | **~1.5M / s** |
| random playout | ~7k / s | **~30k / s** |

Both implementations are cross-validated against each other on tens of thousands of
random positions, so the fast path cannot silently disagree with the rules the UI
uses.

### Evaluation (`js/ai/evaluate.js`)

Features, weighted by phase (the weights are interpolated from a table indexed by
the number of empty squares):

- **mobility** — legal moves for each side; the dominant mid-game term
- **stability** — discs that can never be flipped, resolved exactly for the four
  edges with a 64 KiB lookup table keyed on the edge occupancy
- **corners and traps** — corners, minus own discs squatting on the X/C squares of
  an empty corner
- **disc balance** — nearly irrelevant early, decisive late
- **parity** — who takes the last move; only weighted in the final plies

### Monte-Carlo tree search (`js/ai/mcts.js`) — default

- UCT selection with a single node perspective (the searching player's), so
  maximising and minimising nodes share one comparison rule.
- **Tree reuse**: the tree survives between moves; after your reply the engine walks
  its own tree to the new position and keeps every visit that is still valid.
- Forced passes are folded into the parent move (a player who cannot be answered
  simply moves again), and terminal positions carry the exact disc result.
- **Rollouts are truncated after 5 random moves** and the resulting position is
  scored with the shared evaluator instead of being played to the end. Random
  playouts are extremely noisy in Reversi, and short heuristic rollouts are both
  cheaper and much better correlated with the true result.
- Rollouts always take a free corner when one is available.

Tuning was done by self-play, not by intuition (`tools/arena.mjs`, 6–8 games per
match, colours alternated):

| Setting A | Setting B | Result |
|---|---|---|
| 5-ply rollouts | full random playouts | 7–1 |
| 5-ply rollouts | 14-ply rollouts | 7–1 |
| 4-ply rollouts | 8-ply rollouts | 4–2 |
| 3-ply rollouts | 5-ply rollouts | 2–4 |
| exploration 0.25 | exploration 1.1 | 8–0 |
| exploration 0.2 | exploration 0.5 | 7–1 |

Throughput after tuning: **≈120k playouts per second**, more in the mid-game.

### Alpha-beta (`js/ai/alphabeta.js`)

Iterative deepening with principal variation search, a 131k-entry transposition
table, killer moves, a history heuristic, and root ordering by the mobility the
opponent is left with. Because Reversi has no quiet positions, the search naturally
solves the last ~14 plies exactly. Throughput: **≈1M nodes per second**, reaching
depth 11 in 1.5 s from the opening position.

### Which engine is stronger?

In Othello, plain random-playout MCTS is *not* competitive with a decent alpha-beta
search — this was measured, not assumed:

| Match (colours alternated, self-play) | Result |
|---|---|
| untuned MCTS vs alpha-beta, 400 ms/move | **0–4** (alpha-beta won every game) |
| tuned MCTS vs alpha-beta, 400 ms/move | **3–2–1 in MCTS's favour** |
| tuned MCTS vs alpha-beta, 1000 ms/move | **2–5–1 for alpha-beta** (68.8 %) |
| tuned MCTS vs a random player | **8–0** |

So MCTS is the default engine and is genuinely strong after tuning, while
alpha-beta's exact endgame solving pays off as soon as it gets more time. If you
care most about the last twenty moves, pick *Deep search* in the settings.

### Difficulty

Time budgets per move, plus a deliberate blunder chance at the lowest level:

| Level | MCTS | Alpha-beta |
|---|---|---|
| Easy | 200 ms, 22 % random moves | depth 2, 150 ms, 22 % random moves |
| Medium | 600 ms | depth 4, 400 ms |
| Hard *(default)* | 1500 ms | depth 8, 1200 ms |
| Expert | 3500 ms | depth 16, 2500 ms |

---

## Project layout

```
index.html              the whole UI shell
css/
  base.css              reset, typography, layout, shared controls
  themes.css            all three themes as custom-property sets
  board.css             board, discs, flip animation, coordinates
  panel.css             score, engine telemetry, move list
  dialogs.css           settings sheet
js/
  main.js               controller: game flow, AI requests, persistence
  game/
    rules.js            board primitives (array board, the UI's model)
    game-state.js       authoritative game model: turn, passes, history, undo
  ai/
    bitboard.js         64-bit engine primitives in 32-bit halves
    evaluate.js         phase-weighted static evaluation
    mcts.js             Monte-Carlo tree search
    alphabeta.js        iterative-deepening alpha-beta
    worker.js           the worker: message protocol and engine dispatch
    client.js           main-thread promise wrapper around the worker
    yield.js            cooperative yielding and a portable clock
  ui/
    board-view.js       board rendering, discs, animations, keyboard
    panel.js            scoreboard, telemetry, move list
    settings.js         settings sheet
  util/storage.js       defensive localStorage helpers
tests/
  rules.test.mjs        rules + game state vs a naive reference implementation
  bitboard.test.mjs     the bitboard layer vs the array implementation
  evaluate.test.mjs     evaluation properties (symmetry, stability, tempo)
  alphabeta.test.mjs    legality, tactics, beating a random player, endgame
  mcts.test.mjs         legality, tree reuse, forced passes, strength
  dom.test.mjs          the real app booted in jsdom with a stubbed worker
  browser.html          in-page suite for a real browser
tools/
  serve.mjs             tiny static server
  bench.mjs             micro-benchmarks for the hot paths
  arena.mjs             self-play matches between engine configurations
  browser-check.mjs     headless-browser run of tests/browser.html + screenshots
  diag-mcts.mjs         engine-vs-random diagnostics
```

---

## Testing

```bash
npm run test:logic     # rules, bitboards, evaluation, both engines (no dependencies)
npm test               # the above + the DOM integration test (needs jsdom)
npm run bench          # micro-benchmarks
npm run arena -- --games 8 --a mcts:1000 --b ab:1000   # self-play match
npm run check          # headless browser: in-page suite + screenshots
```

`npm run check` needs Chrome or Edge installed. It launches the browser in
headless mode; in heavily sandboxed environments (where the browser cannot create
its inter-process channels) only the Node suites will run.

The suites are deliberately adversarial: the bitboard layer is checked against a
second implementation, and the engine tests play real games against random
opponents and assert the engine wins. Three genuine bugs were caught this way
during development — a move list shared between search plies, a rollout sign that
attributed half of all results to the wrong player, and corners counted twice in
the stability evaluation.

`tests/dom.test.mjs` boots `index.html` in jsdom, imports the real modules and
drives the real controller (worker included, with the engine stubbed onto the Node
event loop). It covers: boot, playing a move, the engine's reply, undo, hint,
illegal clicks, computer-versus-computer, theme persistence, new game, settings
changes and game saving.

---

## Notes on the original implementation

This project started as a C++ / EasyX rewrite request for an older implementation
of the same game. That code is preserved in the first commit of the repository
(`git show 5d7aa1a`) but is no longer in the working tree. Its bugs informed this
rewrite; some of the problems found while reading it:

1. **Evaluation scores stored in `char`.** `prime_score` holds `char` weights and
   `gettag()` returns `char` while summing terms that reach 5 and products that
   reach 5x64 — the sums overflow and wrap, so the evaluation is meaningless in
   ordinary positions.
2. **Corner logic uses the wrong indices.** In `gettag()`, two of the four corner
   checks test `board[0][6] || board[1][0]` but then subtract
   `board[0][6] + board[1][7]`, mixing up which squares are being measured.
3. **The pruning heuristic is invalid for negative scores.** `deep_bot()` prunes with
   `sctest >= screc * 0.75`; since evaluations are routinely negative, the
   comparison flips and the search cuts good branches while keeping bad ones.
4. **White's search does not use white's evaluation.** The leaf evaluation is always
   `getAI(1)` — black's weights and black-relative terms — even inside the
   white-minimising part of the tree.
5. **Broken minimax bookkeeping.** `counter` is reset to 0 for every candidate move
   and `score[counter + 1]` is read from a slot that the previous subtree
   overwrote, so sibling subtrees contaminate each other. The search is not a
   correct minimax beyond the first ply.
6. **`char` everywhere.** Depth, round and move coordinates are all `char`; the
   history is `char[160][3]` indexed by a `char`, and the displayed line is limited
   to `chess_tree[4][2]` regardless of the configured depth.
7. **Inconsistent move encodings.** Ordinary moves are stored as ±1 in
   `game[round][2]`, forced placements as ±2; `rerun()` decodes both, but the
   save/load format writes the raw values and replays them through `move()`, so a
   reloaded game silently changes its own history.
8. **Busy-wait input loop.** `input()` spins on `peekmessage()` with no sleep,
   pinning a core while waiting for a click; the menu then sprinkles `Sleep(100)`
   calls, which is why the original interface stutters.
9. **User-supplied filenames go straight to `remove()` and `fstream::open()`**, so a
   mistyped name deletes or creates arbitrary files, and a missing file is read
   without checking whether the stream opened.
10. **Global mutable state.** The AI keeps its board, score stack, move tree and
    counters in globals (`AIboard`, `score[]`, `tree[]`, `counter`), which makes it
    non-reentrant — the reason it could not simply be moved off the main thread.
11. **No error path.** `main()` loops forever with `while (1)`; the only exits are the
    menu's quit button, and a failed AI move (for example after a mis-set
    `AIhelpx`) leaves `move()` silently doing nothing, so the AI-versus-AI loop
    spins forever.
12. **The UI is drawn with primitive calls.** Discs are five concentric
    `fillcircle()` calls imitating a gradient, buttons are redrawn by hand after
    every event, and text is positioned with manual pixel offsets and Chinese font
    names — impossible to restyle, localise or scale.

Everything in this repository is the consequence: rules and engines live in their
own modules with typed, validated interfaces, the interface is DOM + CSS, the search
runs off the main thread, and the AI has an actual test suite.

---

## Licence

MIT. See [LICENSE](LICENSE).
