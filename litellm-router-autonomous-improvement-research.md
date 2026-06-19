# Autonomous Improvement of Model Routers — State of the Art + OpenCrane Application

*Companion to `litellm-byok-byom-research.md`. Answers: what is the state of the art for a "nightly job that reviews the router's choices, critically assesses them, and improves them," and how model choice fits OpenCrane's skills-development infra. All claims web-verified against primary sources (arXiv, official repos/docs); citations inline.*

---

## 1. TL;DR

- **There is no off-the-shelf "self-improving router."** The state of the art is a **loop** assembled from four mature research traditions: (1) **LLM-as-a-judge** supplies the critique signal, (2) **off-policy / counterfactual evaluation** answers "would a *different* model have been better?" from logs alone, (3) **contextual bandits / RL** is the policy that learns and explores, (4) **eval-driven CI + self-improving-agent guardrails** safely promote the change. The single most on-point end-to-end blueprint is **EDDOps** (arXiv [2411.13768](https://arxiv.org/html/2411.13768v3)).
- **LiteLLM does not learn.** Its router (`simple-shuffle`, `latency-based-routing`, `cost-based-routing`, …) is static/reactive — confirmed in [docs.litellm.ai/docs/routing](https://docs.litellm.ai/docs/routing). You close the loop **externally** and write the result back via `/model/update`, `router_settings`, and per-key `models[]` (persisted with `STORE_MODEL_IN_DB`).
- **The whole loop is buildable on AGPL-friendly OSS:** LiteLLM (MIT) + **RouteLLM** (Apache-2.0, the de-facto open router) + **Langfuse** (MIT, traces + per-call quality scores + eval datasets) + a nightly optimizer. Avoid **Arize Phoenix** for *bundling* — it's Elastic License v2, source-available but not OSI/AGPL-compatible.
- **The right OpenCrane framing is "model floor per skill," not "global router."** Each skill in the skills registry carries an eval set + a quality bar; the nightly job finds the **cheapest model that still passes that skill's bar** and writes it into the effective-contract as that skill's default. This is task/capability-aware routing (TRouter/FineRouter, [2604.09377](https://arxiv.org/abs/2604.09377)/[2603.19415](https://arxiv.org/pdf/2603.19415)), and **DSPy** (per-module LM + metric-driven optimizer) is the closest prior art.
- **Four design rules the literature is unanimous on** (skip any one and the loop silently degrades): log routing **propensities + keep exploring**; **decouple the judge from the routed model families** (self-preference bias is real and you're multi-vendor BYOM); gate on a **frozen private hold-out with statistical significance**; **never auto-deploy** — shadow → canary → human-approve with rollback.
- **Crawl/walk/run:** start with the trivially-correct version (a nightly SQL pass: "cheapest model whose judge-score on each skill's eval set ≥ bar"), then graduate to a learned router (RouteLLM) and online bandit exploration only if the data justifies it.
- **Cost impact (§10): net ~15–45% off blended provider spend at real volume**, with the loop's own token overhead held to low single digits % — *if* you use a learned/embedding router (not an LLM) at serve time, sample judging (1–5%), trigger-based eval (not literally nightly), and a per-skill volume threshold. Savings scale with traffic; the dominant overhead is fixed, so it's net-positive at volume and net-negative on long-tail skills (don't optimize those).
- **First move is measurement, not building (§11):** run the loop in **shadow mode** — log + judge a sample + compute via OPE what routing *would* have saved — before changing any live routing. Cheap, zero production risk, and the only honest way to size the prize.

> **Provider-credential context (per the BYOK report's locked decisions):** provider keys are **central / per-ClusterTenant**, not per-openclaw-tenant; model choice rides on those central accounts and is expressed per-skill in the effective-contract. This loop optimizes *which model* a skill uses, not *whose key* pays — the two are orthogonal.

---

## 2. The honest framing

The phrase "self-improving router" maps to a **closed-loop control system**, not a model. The reference loop:

```
serve (router picks model, logs choice + propensity + outcome)
   → judge/critique the choices (LLM-as-judge, calibrated)
   → counterfactually evaluate candidate policies on the logs (OPE)
   → propose a policy update (refit bandit / retrain router / optimize thresholds)
   → gate on a frozen hold-out + significance test
   → shadow → canary → human-approve → promote (with kill-switch)
   → back to serve
```

GPT-5's August-2025 built-in router is the canonical *commercial* instance of this: OpenAI states its router is "continuously trained on real signals, including when users switch models, preference rates for responses, and measured correctness, improving over time." You're rebuilding that pattern on OSS, with the advantage that your "preference signal" can be **per-skill eval pass/fail**, which is cleaner than implicit user signals.

---

## 3. State of the art — the routers themselves

Two paradigms ([survey "Doing More with Less", 2502.00409](https://arxiv.org/abs/2502.00409); [survey "Dynamic Model Routing and Cascading", 2603.04445](https://arxiv.org/abs/2603.04445)):

- **Predictive (pre-generation)** — a learned predictor picks the model *before* inference. Cheap; can mispredict.
- **Cascade (post-generation)** — run cheap model, *verify*, escalate only if insufficient. More reliable; pays for the cheap call.

### OSS / self-hostable building blocks (AGPL-friendly)

| Component | License | Role | Source |
|---|---|---|---|
| **RouteLLM** | **Apache-2.0** | The reference open router framework. 4 router types: similarity-weighted, **matrix-factorization (recommended)**, **BERT classifier (<10ms, no LLM call)**, causal-LLM. ~85% cost cut on MT-Bench at 95% of GPT-4 quality. Trainable on *your* logs with LLM-judge labels — no human preference data required. | [github.com/lm-sys/RouteLLM](https://github.com/lm-sys/RouteLLM), [paper 2406.18665](https://arxiv.org/pdf/2406.18665) |
| **semantic-router** | **MIT** | Embedding-based route→model selection (~100ms, no LLM call). The practical substrate for *task/skill* routing ("this skill's prompts route to model X"). | [github.com/aurelio-labs/semantic-router](https://github.com/aurelio-labs/semantic-router) |
| **Hybrid LLM / BEST-Route** | **MIT** | Difficulty router: predict the small-vs-large "quality gap," threshold to trade cost/quality. BEST-Route (MS, 2025): ~60% cost cut at <1% drop. | [microsoft/best-route-llm](https://github.com/microsoft/best-route-llm) |
| **PILOT** | research | **The on-point bandit router**: LinUCB seeded from offline preferences, refined online, with a knapsack budget policy. | [2508.21141](https://arxiv.org/abs/2508.21141) |
| **ParetoBandit** | research | Handles **non-stationarity**: geometric forgetting tracks price/quality drift; **cold-starts a newly-added model in ~142 steps**. Directly relevant to BYOM where models appear/disappear constantly. | [2604.00136](https://arxiv.org/abs/2604.00136) |
| **RouterBench / RouterEval** | open / MIT | Eval harnesses. Score routers on the **cost-quality Pareto frontier** via **AIQ** (area under convexified curve) / **APGR** (fraction of cheap→strong gap recovered). | [2403.12031](https://arxiv.org/abs/2403.12031), [2503.10657](https://arxiv.org/abs/2503.10657) |

**Cautionary result:** a plain **kNN-over-embeddings router often matches elaborate learned routers** ([2505.12601](https://arxiv.org/html/2505.12601v1)) — always benchmark fancy routers against a kNN baseline before paying the complexity. And routers are **attackable/driftable** — adversarial prompts can flip routing ([2501.01818](https://arxiv.org/pdf/2501.01818)) — so they need monitoring.

**Proprietary (approach replicable, code is not):** NotDiamond (powers OpenRouter's auto-router), Martian, Unify.ai, Requesty, GPT-5's router. None self-hostable; RouteLLM is the OSS analogue.

---

## 4. The nightly critique-and-update loop (the core answer)

Five stages, each backed by an established literature.

### Step A — Judge / critique the logged choices
A strong judge agrees with humans ~80% — the same rate humans agree with each other ([MT-Bench, 2306.05685](https://arxiv.org/abs/2306.05685)) — which licenses automated grading. Use **G-Eval**-style scoring ([2303.16634](https://arxiv.org/abs/2303.16634)). **The biases that will corrupt a routing critic:**
- **Self-preference** — a model over-scores its own outputs, proportional to how well it recognizes them ([2404.13076](https://arxiv.org/abs/2404.13076)). **Critical for you:** a GPT-family judge grading a router that *includes* GPT will bias the policy toward GPT. **Use a neutral third-party judge or an ensemble; never let a model judge its own family.**
- **Position bias** (fix: average over both orderings, [2305.17926](https://arxiv.org/abs/2305.17926)) and **verbosity bias** (length-matched win rates, [2407.01085](https://arxiv.org/abs/2407.01085)).
- Pairwise tracks preference better but is more gameable (~35% flip vs ~9% pointwise under distractors, [2504.14716](https://arxiv.org/abs/2504.14716)) — run pairwise with position-swap + length control, backstopped by pointwise.
- **Calibrate the cheap judge against a small human-graded oracle slice** ([Causal Judge Evaluation, 2512.11150](https://arxiv.org/pdf/2512.11150)). Anthropic/OpenAI guidance both say: validate judge↔human agreement *before* optimizing against it.

### Step B — Counterfactually evaluate candidate policies (the "critically assess" core)
This is what separates a real critique job from naive re-grading: estimate what a *different* routing policy **would have scored on yesterday's logs**, before deploying it.
- **Doubly-Robust (DR)** is the default estimator — unbiased if *either* the propensity or reward model is right, low variance ([1103.4601](https://arxiv.org/abs/1103.4601)). Fall back to **SNIPS/SWITCH/DRos** when importance weights are heavy; **Replay** ([1003.5956](https://arxiv.org/abs/1003.5956)) is the simplest unbiased baseline if logging is randomized. Tooling: **Open Bandit Pipeline** ([2008.07146](https://arxiv.org/abs/2008.07146)) implements all of these.
- **The pitfall that bites routing specifically:** a **deterministic argmax router records 0/1 propensities → OPE cannot evaluate any policy that routes differently.** Fix: inject ε-exploration / randomized logging, or lean on DR with a fitted reward model. Always report **bootstrap 95% CIs** and **check per-segment heterogeneity** — the closest precedent ([multi-turn LLM routing OPE, 2510.17173](https://arxiv.org/html/2510.17173)) found the "best-on-average" policy *harmed whole subpopulations* that the average hid.

### Step C — Propose the update
Either **bandit-native** (refit LinUCB / update Thompson posterior on new labels — PILOT [2508.21141](https://arxiv.org/abs/2508.21141); hot-swap drifting/new models — ParetoBandit [2604.00136](https://arxiv.org/abs/2604.00136)) or **optimizer-native** (reflect on failures → propose new routing thresholds/prompts — **GEPA** [2507.19457](https://arxiv.org/abs/2507.19457), **DSPy MIPROv2** [2406.11695](https://arxiv.org/abs/2406.11695), **TextGrad** [2406.07496](https://arxiv.org/abs/2406.07496)).

### Step D — Gate the update (regression CI)
Run the candidate against a **frozen, private golden/hold-out set that is never used to tune the judge** (anti-gaming; build it from real production failures, version it). Ship only if the **95% CI on the quality delta excludes zero** ([Adding Error Bars to Evals, 2411.00640](https://arxiv.org/abs/2411.00640)); repeat each test N times to absorb judge noise (promptfoo `repeat`). **Cap optimization pressure** to stay left of the Goodhart turning point, where quality peaks then *degrades* as you over-optimize against an imperfect judge ([Scaling Laws for Reward Model Overoptimization, 2210.10760](https://arxiv.org/abs/2210.10760)).

### Step E — Safe rollout + human approval
**EDDOps** ([2411.13768](https://arxiv.org/html/2411.13768v3)) prescribes the spine: offline checks vs pinned baselines → **shadow (0% live) → canary → staged expansion**, feature-flag + kill-switch rollback, humans retain authority over high-impact changes, every change versioned and traceably linked to the finding that triggered it. **Never auto-deploy a policy change.**

### The four non-negotiable rules
1. **Log propensities / keep exploring** — a deterministic argmax router starves both its OPE critic (Step B) and its bandit learner (Step C).
2. **Decouple the judge from the routed model families** — self-preference bias skews a multi-vendor router toward the judge's own family.
3. **Gate on a frozen private hold-out + significance test** — prevents judge-gaming and shipping on noise.
4. **Shadow → canary → human-approve with rollback** — and cap optimization pressure (Goodhart).

---

## 5. Model choice in OpenCrane's skills-development infra — the synthesis

This is where it becomes OpenCrane-specific and most valuable. The framing is **"model floor per skill,"** and it slots directly into the effective-contract you already compile.

**The pattern (documented as "routing-plus-eval"):** define a quality bar per task, then **"select the lowest-cost model meeting the quality threshold"** — literally a ranked query over eval scores ([TrueFoundry](https://www.truefoundry.com/blog/llm-routing-cost-quality-aware-model-selection), [Portkey task-based routing](https://portkey.ai/blog/task-based-llm-routing/)). The repeated warning: *"routing on vibes is how a quality regression ships unnoticed"* — **the per-skill eval set is mandatory, not optional.**

**Mapping onto OpenCrane:**
1. **Each skill carries an eval set + a quality bar.** Make this part of the skill's metadata in the skill registry — a small golden set of representative tasks for that skill, plus the pass bar (e.g. judge score ≥ 0.8, or N/M golden tasks correct). This makes "skills development" and "model selection" the same artifact: developing a skill *means* defining how you'd know a model is good enough at it.
2. **The nightly job grades candidate models against each skill's eval set** (LLM-judge with a neutral judge, or golden answers), and computes the **cheapest model that clears the bar** per skill. That model becomes the skill's **default/floor**; a stronger model is the escalation tier for hard instances (cascade).
3. **The selection is written into the effective-contract** as the per-skill (or per-tenant×skill) model recommendation. The pod re-pulls the contract at each agentic-loop boundary (as it already does for skill/MCP grants per [3-deployment.ts](apps/operator/src/tenants/deploy/3-deployment.ts)), so model choice propagates the same way grants do — no new propagation path.
4. **Cost is a first-class objective** because you meter (not mark up): the routing objective is literally `quality − λ·cost`, and λ is your budget posture. When a cheaper model starts passing a skill's bar (new release, price drop), the nightly job demotes the expensive default automatically — exactly the autonomous improvement you asked for.

**Prior art for "bind model to a capability with a quality gate":** this is the least-standardized area, but **DSPy** is the strongest fit — a program is typed **modules/signatures**, you can assign a **different LM per module** (`dspy.context(lm=...)`), and its **optimizers compile each module against a metric until quality converges** ([dspy.ai](https://dspy.ai/)). That is structurally "each skill declares a task spec + quality metric, framework selects/optimizes the model." You don't have to adopt DSPy, but its model is the template: **skill = signature + eval metric; selection layer = RouteLLM / semantic-router / a SQL pass.**

---

## 6. How it bolts onto your LiteLLM + control plane (concrete hooks)

LiteLLM is the gateway and gives you both halves of the loop:

**Read (decision + outcome logs):** register a `CustomLogger` (`litellm.callbacks=[handler]`); each `log_success_event` carries a `StandardLoggingPayload` with `model`, LiteLLM-computed `response_cost`, latency, `cache_hit`, and **`litellm_params.metadata`** — **stamp the skill id + chosen deployment + routing propensity there** ([custom_callback docs](https://docs.litellm.ai/docs/observability/custom_callback)). Externalize to **Langfuse (MIT)** for traces + per-call quality scores + eval datasets ([langfuse self-hosting](https://langfuse.com/self-hosting)); LiteLLM has native Langfuse + OTEL integrations. Plus the spend/usage Postgres DB you'll already have from the BYOK work.

**Write (push the new policy):** `POST /model/update`, `router_settings`, and per-key/per-team `models[]` (which resolve **Keys > Teams > Global**, [docs](https://docs.litellm.ai/docs/proxy/keys_teams_router_settings)). With `STORE_MODEL_IN_DB=true` (the same switch the BYOK work needs), changes **persist across restarts and propagate across replicas with no restart** ([db_info](https://docs.litellm.ai/docs/proxy/db_info)).

**Governance (your IAM-first rule):** the nightly optimizer is just another API client. Policy changes flow through the **control plane**, are **IAM-gated and audited** (you already audit key revocation in `ai-budget.logic.ts`), and surface as a **human-approvable diff** before promotion — satisfying EDDOps Step E *and* your "API is the enforcement point" rule. The optimizer never writes to LiteLLM directly.

```
  LiteLLM (serve + log: skill id, model, propensity, cost, latency)
        → Langfuse (traces + judge scores + per-skill eval datasets)
        → nightly optimizer (judge → OPE → cheapest-model-≥-bar per skill)
        → control plane (IAM-gated, audited, human-approved diff)
        → LiteLLM /model/update + per-key models[]  +  effective-contract per-skill default
        → pod re-pulls contract at loop boundary
```

**Auxiliary signal — guardrail logs (a "GuardLLM" / safety service). Verified 2026-06-18: not implemented anywhere in `opencrane-2`** — no Helm component, no runtime call, no config wiring, and no reference in any brief or plan (the only "guard" hits are the unrelated L0 personalisation guard, the multi-instance fail-closed guard, and type guards). It appears to have been part of an earlier/external design that was never built here. *If* a guardrail service is later added, its logs are a **different kind of signal** than this loop's: safety/policy events (PII, prompt-injection, toxicity, blocked output, per-scanner scores) — *"was this safe,"* not *"was this the right model."* It would play two roles, neither replacing the quality judge: (1) a **hard routing filter** (never route a skill to a model that fails its scanners) and (2) **one term in the per-skill score** (a model that trips guardrails more is worse on the safety axis). Wiring is uniform: emit events to the same trace store (Langfuse) keyed by request + skill id; a LiteLLM guardrail callback's verdicts already land in `StandardLoggingPayload.metadata`. **Tracked as future work (plan.md Track AIR / safety), not part of the routing loop.**

---

## 7. Recommended build order (crawl / walk / run)

- **Crawl — the trivially-correct version (highest ROI).** Per-skill eval sets + nightly **"cheapest model whose neutral-judge score on the skill's eval set ≥ bar"** SQL pass over Langfuse scores → write the per-skill default into the contract behind a human-approved diff. No learned router, no bandit. This alone delivers autonomous, eval-gated model selection and is the 80/20.
- **Walk — counterfactual rigor.** Add propensity logging + ε-exploration so you can run **DR/SNIPS OPE** (Open Bandit Pipeline) to *critically assess* "would a different model have been better" with CIs, and catch per-tenant/per-skill regressions the average hides.
- **Run — learned + online.** Introduce **RouteLLM** (matrix-factorization or BERT router, retrained nightly on judge-labelled logs) for within-skill hard/easy splitting, and/or a **bandit (PILOT/ParetoBandit)** for online exploration and automatic cold-start of newly-registered BYOM models. Only if the data shows the simpler tiers leave material cost/quality on the table — benchmark against a **kNN baseline** first.

---

## 8. AGPL / licensing notes

- **Use directly (permissive, self-hostable):** LiteLLM (MIT), RouteLLM (Apache-2.0), semantic-router (MIT), DSPy (MIT/Apache), **Langfuse (MIT)**, Open Bandit Pipeline (Apache-2.0), Hybrid-LLM/BEST-Route (MIT).
- **Langfuse eval features are MIT/free on the OSS self-hosted build** (verified; relicensed out of `ee/` into MIT in June 2025): managed LLM-as-a-judge evaluators, online (sampled-%) production evals, datasets + experiments, annotation queues, the public + v1 metrics APIs. **Only** enterprise *security/admin* modules are paid (SAML/SCIM SSO, project-level RBAC, audit logs, data-retention, server-side masking) — none of them eval features. Langfuse's core is **MIT** (looser than AGPL), so it imposes no copyleft on the platform. (Source: langfuse.com/docs/open-source, /self-hosting/license-key.)
- **Avoid bundling:** **Arize Phoenix is Elastic License v2** — source-available, self-hostable, but **not OSI/AGPL-compatible**; Langfuse (MIT) is the cleaner observability pick. **Helicone** (Apache-2.0) is fine but in maintenance mode since its Mar-2026 acquisition.
- **Cannot self-host:** NotDiamond, Martian, Unify.ai, Requesty, OpenRouter auto-router, GPT-5 router — managed/proprietary. Their approaches are replicable on the OSS stack above.

---

## 9. Pitfalls to design against (summary)

1. **Self-preference judge bias** — neutral/ensemble judge; never judge own family (you're multi-vendor).
2. **Propensity starvation** — a deterministic router can't critique itself; log propensities + explore.
3. **Goodhart / reward overoptimization** — frozen hold-out, significance gate, cap optimization pressure.
4. **Router attacks/drift** — monitor routing decisions; periodic recalibration.
5. **Complexity tax** — benchmark learned routers against kNN; don't ship ML you don't need.
6. **Per-segment harm** — report per-tenant/per-skill deltas with CIs, not just the global average.

---

## 10. Token-cost impact of the loop

The loop both **saves** tokens (routing the easy fraction to cheaper models) and **spends** them (the judge + eval runs). It is net-positive at volume because of an **asymmetry**: savings scale with traffic (`O(volume)`) while the dominant overhead — re-evaluating candidate models — is essentially **fixed** (`O(skills × models × eval-items)`). The trap is running the full loop on low-volume skills, where fixed overhead exceeds savings.

**Where tokens are saved (serve-time, ∝ volume).** Benchmark headlines are optimistic (RouteLLM ~85% on MT-Bench; BEST-Route ~60% at <1% drop — 2-model, single-benchmark). **Realistic blended expectation: ~20–50% off the routable portion**, workload-dependent. *Only* materializes if the routing decision itself costs ~0 tokens → **learned/embedding router (RouteLLM BERT/MF, semantic-router) at serve time, never an LLM-as-router.**

**Where tokens are spent (overhead) and how to bound each:**

| Component | Scales with | Bound it |
|---|---|---|
| **LLM-as-judge** (the big one) | sampled volume | **Sample 1–5%**, not 100%; cheaper judge calibrated to a small oracle slice. 100% frontier judging can cost ~as much as inference. |
| **Candidate eval** | skills × models × items (fixed) | **Trigger-based, not literally nightly** (new model / price change / drift, or weekly cap); small golden sets (20–50); test only relevant candidates per skill. |
| **Exploration** (for OPE/bandits) | small % of traffic | Keep ε at a few % — the "price of learning." |
| **Cascade waste** (if used) | escalation rate | Only where verification is cheap. |
| OPE, Langfuse, control plane, pod re-pull | — | **0 LLM tokens.** |

**Illustrative net** (assumptions explicit): one skill at 10M tokens/month, 100% on a frontier model, 60% of requests "easy" → routing ≈ **54% gross savings**; sampled judging ≈ **2%**; weekly eval ≈ **3–4%** → **~47% net**. The *same* loop on a 200k-tokens/month long-tail skill: weekly eval alone exceeds the skill's entire traffic → **net-negative**. Hence the **per-skill volume threshold** rule.

**Three hidden costs that can erase savings:** (1) **prompt-cache breakage** — re-routing mid-conversation invalidates provider caches and can *raise* cost → **pin the model within a session, route across sessions**; (2) **"nightly" is a misnomer for the eval half** — judge *sampling* can run continuously, candidate *re-eval* must be trigger-based; (3) a **bad auto-rollout** (Goodhart-gamed judge) → retries/escalations that cost more than the routing saved → which is why the loop ends in human-approved canary, not auto-deploy.

**Bottom line:** because OpenCrane **meters rather than marks up**, 100% of net savings flow to the provider bill, and since model choice is per-skill in the contract the savings are **attributable per skill and per tenant** (you can show a customer "this skill got 47% cheaper at equal quality"). Expect **~15–45% blended reduction at real volume**, overhead in **low single digits %**, *if* the discipline above holds.

---

## 11. First experiment — shadow-mode savings measurement

The honest way to size the prize without touching live routing. **Zero production risk; all OSS.** This is the concrete first build for the whole router track.

**Goal.** For the top-K highest-volume skills, estimate — from real traffic — what % spend the routing loop *would* save at equal quality, with confidence intervals, before changing any routing decision.

**Steps:**
1. **Instrument (no behaviour change).** Add a LiteLLM `CustomLogger` that stamps `skill_id`, chosen model, request features, cost, latency into `StandardLoggingPayload.metadata`; export traces to **Langfuse** (MIT). Everything still goes to the current default model.
2. **Define per-skill bars.** For each top-K skill, assemble a **frozen golden set (20–50 items)** + a quality bar (judge score ≥ X, or N/M correct). This is the load-bearing input and the artifact that ties this to skills-development.
3. **Shadow-grade (nightly batch).** Sample S% of logged traffic per skill; for each sampled request, run the **candidate cheaper model(s)** on the same input and have a **neutral judge** (not the candidates' vendor) score both against the bar. Produces, per skill, the **fraction the cheap model could have served at-bar**.
4. **Estimate via OPE.** Counterfactual cost = cheap-model cost for the at-bar fraction, current otherwise; use **doubly-robust / replay** (Open Bandit Pipeline) with **bootstrap 95% CIs** and a **per-tenant breakdown** (catch the "best-on-average harms a subpopulation" trap).
5. **Report + decide.** Per skill: volume, at-bar-cheap fraction, projected % savings ± CI, **and the judge+eval tokens actually spent** (so the savings:overhead ratio is real). Greenlight the live crawl-phase loop only for skills where projected net savings clears a threshold with CI excluding zero; keep a static default elsewhere.

**Cost of the experiment itself** = sampled judging + candidate re-runs on the sample + small eval sets — bounded by the sample rate, and it produces the data to justify (or kill) the whole track.

**Stack:** LiteLLM `CustomLogger` → Langfuse (traces / scores / eval datasets) → Open Bandit Pipeline (OPE) → a neutral judge. All AGPL-friendly. **Prerequisite it shares with BYOM: DB-backed LiteLLM** (`STORE_MODEL_IN_DB`) so candidate models can be registered to run during grading.

**Deliverable:** a per-skill table — *"routing would save X% ± Y at equal quality; overhead Z%; recommend optimize / keep-static."* That table is the go/no-go for everything downstream.

---

## 12. Model selection modes, the "auto" gate & per-skill model config

Routing is **opt-in**. Most calls use an explicitly chosen model; the autonomous loop above runs **only for callers/skills that select "auto."** This keeps behaviour predictable — auto is a feature, never a surprise.

### Selection precedence (highest wins)
1. **Explicit model in the request** (user picks a model in UI/CLI for this call) → **use it verbatim, no routing.**
2. **Skill-pinned model** (a skill self-defines its model) → use it for that skill's calls.
3. **"auto"** (request- or skill-level opt-in) → the router/optimizer picks within the auto config (§§4, 10, 11).
4. **Global default** → fallback when nothing above is set.

Mechanically the resolved model is written into the effective-contract (per-skill) + the pod's `models[]`/default; the per-tenant virtual key's `models[]` allowlist is the hard ceiling on what *any* mode may select (control-plane-enforced, §4 rules). Auto is a per-skill (or per-tenant-default) flag — never global-implicit.

### How per-skill resolution works — intent → resolution → enforcement

A common misread is "model selection is a property of the skill." It isn't — the skill carries **intent** (its posture); the **concrete model** a tenant runs is `posture × the tenant's scope defaults`, resolved per-tenant when the effective-contract is compiled. Three distinct layers:

| Layer | Where it lives | What it holds |
|---|---|---|
| **Intent** | the `Skill` row's posture (`modelMode`/`pinnedModel`/`autoConfig`) | the author's choice: pinned · auto · inherit |
| **Resolution** | `_ResolveContractSkillModels` → `_ResolveSkillModel` at contract-compile | `posture × scope defaults` → the concrete model for *this* tenant, *now* |
| **Enforcement** | the per-tenant LiteLLM virtual key's `models[]` allowlist (AIR.0c) | the hard runtime gate on what any selection may reach |

**The resolver** (`apps/control-plane/src/core/model-routing/`): `_ResolveContractSkillModels` (the DB wrapper) loads the scope defaults **once** — the Global `ModelRoutingDefault` plus the tenant's ClusterTenant default when it has one — and the posture rows for the entitled skills (joined by name; a posture-bearing row beats a null one). It then runs the **pure** `_ResolveSkillModel` per entitled skill, emitting `{ skillId, model, auto }` into the contract's `skills.models`. The resolver does **no I/O and never calls LiteLLM** — the wrapper does the loads, so the precedence stays unit-testable and the compile stays cheap.

**Per-posture resolution** (the precedence chain `_ResolveSkillModel` implements):
- **`pinned`** → `pinnedModel`. The *only* case where the skill itself names the concrete model.
- **`auto`** → the **scope default** is the anchor model (ClusterTenant default, else Global), with the skill's `autoConfig`, and `auto: true`. The resolver does **not** pick the cheapest-passing model here — there's no live measurement at compile time; the live pick is the runtime/optimization-loop's job (the loop writes a new default, which the next contract re-pull reflects).
- **`null` (inherit)** → the scope default (and it inherits the default's auto-ness when that default is itself an auto config).
- **nothing resolves** → `model: null`; the pod falls back to its own configured default.

**Why resolution can't be a skill field:**
- **Tenant-specific** — one `Skill` (keyed `name/scope/team`, entitled to many tenants) resolves to *different* models per customer, because ClusterTenant defaults differ.
- **Time-varying** — a scope-default change, or an AIR.7 proposal approval, re-resolves the model with **no edit to the skill**.
- **Compiled + re-pulled** — the contract is the per-tenant view the pod re-pulls at each agentic-loop boundary; that's the right place to materialise "the model for this tenant, right now."

**Where the other precedence tiers sit:** the **explicit per-request model** (top of the chain) is honoured at request time by the pod/gateway and is deliberately *not* an input to the resolver; the **pod's own configured default** is the `model: null` fallback at the bottom. The resolver owns only the middle tiers (pinned → auto → scope-default). The contract field is emitted by `routes/internal/tenant-contract.ts` (`skills.models`).

### Skill-level model definition
A skill can declare its own model in the skill-registry metadata — either a **pinned** model (mode 2) or **`auto`** with a per-skill auto config (mode 3). This is the same artifact as the per-skill eval set (§5): developing a skill includes deciding its model posture. Surfaced API-first + `oc skill …` + WeOwnAI.

### Configuration options for "auto"
When a caller/skill selects auto, expose these knobs (all OSS-implementable; defaults in **bold** give cost-down-at-equal-quality with no surprises):

| Option | Values | Notes |
|---|---|---|
| **Objective / strategy** | **cheapest-passing-bar** · best-quality-within-budget · balanced | Balanced = the `quality − λ·cost` dial; expose as a single **cost↔quality slider (0 cheapest … 10 best)** in the UI. |
| **Quality floor** | **the skill's eval bar** · custom score | The hard gate — auto never picks a model below it. |
| **Budget cap** | per-request · per-token · monthly | Reuses the existing budget / `max_budget` machinery. |
| **Allowed model set** | **the key's `models[]`** · narrower subset | Auto can only choose within the virtual key's allowlist. |
| **Latency ceiling** | none · max ms · prefer-fast | Filters/penalizes slow models. |
| **Fallback chain** | ordered models | On failure/unavailability (`router_settings.fallbacks`). |
| **Scope** | global default · per-ClusterTenant · per-skill · per-request | Finer scope overrides coarser. |
| **Session pin** | **on** · off | Keep the chosen model stable within a conversation to preserve prompt caches (off → churn → higher cost; see §10). |
| **Exploration** | **off** · on (ε %) | On lets the improvement loop sample alternatives to generate the propensity-bearing logs OPE needs (§4). Off = pure exploit. |

### Future work — fixed-model-skill savings evaluator (advisory)
For skills pinned to a fixed model (modes 1/2, **not** auto), run the shadow evaluator (§11) continuously and surface an **advisory** — **never auto-change a pinned skill.** WeOwnAI/CLI lists fixed-model skills with a notification like *"By changing this skill's model you could save up to 65% in token cost at equal quality,"* with one-click **"switch to recommended"** or **"enable auto."** This turns the optimization loop into a recommendation engine for the skills a user has deliberately pinned — full user control, savings still surfaced. *(Tracked in plan.md → Track AIR.8.)*

---

## 13. Evals via Langfuse — refinement to AIR.6/7

Verified 2026-06-18 against langfuse.com/docs + the langfuse repo. **All Langfuse eval features are MIT/free on the OSS self-hosted build** (managed LLM-as-a-judge, online sampled-% production evals, datasets + experiments, annotation queues, public + v1 metrics APIs) — relicensed out of `ee/` into MIT in June 2025; only enterprise security/admin is paid (§8). This materially changes AIR.6's build:

- **Lean on Langfuse, don't rebuild the judge.** AIR.6's `shadow-measure.ts` + `JudgeClient`/`ModelRunner` seams should become a **thin layer over Langfuse** rather than a bespoke judge loop: curate per-skill **datasets** in Langfuse, run a **managed LLM-judge evaluator** (offline on the dataset, and/or online on sampled production traces), then read the **Scores** back via Langfuse's v1 Metrics/Public API to compute the savings + CI. Less code, a standard pipeline, and the eval-review UX (evaluator config, experiment A/B, annotation queues, trace inspection) comes for free in the Langfuse UI.
- **Manual vs automatic.** Grading is **automatic** (the LLM-judge runs without hand-scoring). What is irreducibly **manual** is *authoring golden answers + the judge criteria* — and only for **reference-based** metrics (correctness, semantic-equivalence). **Reference-free** metrics (toxicity, relevance, helpfulness, hallucination-vs-context) need **no golden answer** → fully automatic, including dataset curation from live traces.
- **Where eval sets come from.** **Curate a small golden set from each skill's own production traces** (Langfuse "add trace → dataset"), plus CSV/SDK import or synthetic generation. Public benchmarks are a **poor fit for a specific skill** (contamination + distribution mismatch) — use them (RouterBench/RouterEval [MIT], MMLU, etc.) only for **broad model smoke-testing when onboarding a model**, never as the per-skill acceptance gate. Calibrate the cheap judge against a **small human-labeled slice**, and keep the judge **vendor-neutral** (never a routed family — §4).
- **Net effect on the data model:** `RoutingEvalCase` (AIR.6, already landed) becomes the OpenCrane-side index/pointer to a skill's Langfuse dataset + bar; the heavy lifting (judge execution, score storage, experiment comparison) lives in Langfuse.

## 14. Frontend management capabilities (the WeOwnAI console)

WeOwnAI is a **separate proprietary Angular repo** and, per the locked rule, **just another API client**: `/auth/me` claims (`isPlatformOperator`, `clusterTenant`) **hide UI only**; the control-plane API (the AIR.0b scope guard) is the enforcement point. Everything below is backed by AIR APIs that **already exist** plus two small control-plane enablers (see end).

### Langfuse integration pattern (verified)
- **Embed nothing** — Langfuse has no iframe/embed and no per-request SSO deep-link. Don't try to iframe it.
- **Build native over the API** for the at-a-glance views (score trends, eval pass-rates, cost/latency tiles, per-tenant rollups): query Langfuse's **v1 Metrics + Public API** (v2 is Cloud-only today — design self-hosted views around **v1**), **proxied through the control-plane** so Langfuse project keys never reach the browser.
- **Link out** to the full Langfuse UI for the expensive-to-rebuild deep surfaces: trace inspection, LLM-judge evaluator config, experiment A-vs-B comparison, annotation queues. A *seamless* SSO handoff needs enterprise SAML; without it users hit a Langfuse login (acceptable for the admin persona), or scope isolation stays entirely in our proxy.

### Capability catalogue (prioritized) — each mapped to its backing API

| # | Capability | Tier | Backing API (already built unless noted) | R/W |
|---|---|---|---|---|
| 1 | **Per-skill model catalog/picker** (filter price/context/modality/provider) | must-have | `GET /models` + `PUT /skills/posture` | R+W |
| 2 | **Per-skill routing-policy presets** (objective, fallbacks, allowed-models, budget; inheritable tenant→skill) | must-have | `/model-routing/defaults` + `skills/posture.autoConfig` | W |
| 3 | **BYOK provider-credential management** (per tenant, model-scoped, prioritized+fallback) | must-have | `/providers/credentials` | W |
| 4 | **Keys + per-key budgets + soft-budget alerts** | must-have | `/ai-budget/*` | W |
| 5 | **Usage/cost analytics** filterable by tenant/skill/model/provider | table-stakes | Langfuse v1-metrics proxy + `/token-usage` + `/ai-budget/*/spend` | R |
| 6 | **Eval-score trends + experiment comparison per skill** | differentiator | native trend tiles over the metrics proxy + `/model-routing/measurements`; link-out to Langfuse for A/B | R+W |
| 7 | **Cost-quality slider + savings-recommendation** (*"switch skill X → model Y, save N%"*) | **differentiator (whitespace)** | `/model-routing/measurements` + `/model-routing/proposals` | W |
| 8 | **Proposal review queue** (approve/reject the human-gated diff) | differentiator | `/model-routing/proposals/{id}/approve\|reject` | W |
| 9 | **Eval-set curation + judge config** | core-loop | `/model-routing/eval-cases` + link-out to Langfuse datasets/evaluators | W |
| 10 | **Credits/billing per tenant** | platform | `/ai-budget` | W |
| 11 | **Scope-aware hierarchy** (operator vs ClusterTenant views) | platform | `/cluster-tenants`, `/tenants`, `/auth/me` | R+W |
| 12 | **Branded tenant-facing "skill hub"** | platform | `GET /skills/posture` + `GET /models` | R |

Tiers: **1–4** are the must-have control plane; **5** table-stakes; **6–9** the differentiation; **10–12** round out the platform.

### The differentiator (market whitespace)
No surveyed product (OpenRouter, LiteLLM, NotDiamond, Portkey, Requesty, Helicone, Langfuse) surfaces a polished **inline savings-recommendation** — *"this skill is pinned to an expensive model; switching to Y saves N% at equal quality"* — with a **one-click human-gated apply**. NotDiamond does it programmatically; the observability tools show the cost data but leave the decision to the user. Combining **Langfuse-style eval trends** with a **NotDiamond-style cost-quality dial** and our **RoutingProposal approve/reject loop** (#6+#7+#8) is a feature OpenCrane can own — and it is backed entirely by the AIR.6/7 APIs already shipped.

### UI inspiration (concepts, not wire-compat — AGPL)
- **OpenRouter** — model catalog with rich filters; **Presets** (named routing policy decoupled from code) → our per-skill policy; BYOK with prioritized+fallback ordering + "counts toward limit" toggle.
- **LiteLLM Admin UI** — the org→team→project→key budget tree (= ClusterTenant→Tenant→skill); note LiteLLM *monetizes* the model-hub + SSO, validating their value.
- **Helicone** — persistent, URL-shareable filters across every dashboard (the UX bar for #5).
- **NotDiamond** — the single **`cost_quality_tradeoff` 0–10 slider** as the whole auto-config UX (#7).
- **Requesty** — cascading policy engine through the org hierarchy (= our tenant→skill inheritance).

### Control-plane enablers still needed (so the console stays API-first)
1. **AIR.10 — Langfuse-metrics proxy**: a control-plane read endpoint that proxies Langfuse's v1 Metrics/Public API with the project keys held server-side + scoped per tenant (the browser never holds Langfuse credentials).
2. **AIR.11 — savings-recommendation read endpoint**: aggregates the latest `RoutingMeasurement` + open `RoutingProposal` per skill/tenant into the "save up to N%" feed that powers capability #7. (Pure read over data the loop already produces.)

Both are small, additive, and IAM-gated; the frontend *views* themselves live in the WeOwnAI repo (out of this AGPL tree).

---

*Sourcing: every load-bearing claim is cited to a primary source (arXiv paper, official repo, or vendor doc) and was web-verified, including future-dated 2026 arXiv IDs confirmed against their arXiv pages. The recommended stack is entirely AGPL-friendly OSS and reuses the DB-backed LiteLLM the BYOK work already requires.*
