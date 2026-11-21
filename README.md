# Kairos

Version 1 · 21 November 2026 · Track 2 Beyond English · Product name to be decided

## Product decision

Build a general assistant that people call to get something arranged. The caller speaks naturally, the assistant clarifies the request, contacts the relevant people, handles the back-and-forth, and maintains one private live task page. The owner returns when a decision needs them and receives a clear record of the outcome.

The core user job is: “Understand what I need, handle the conversations, and bring me a result I can trust.”

The first release supports three related task types: collecting and comparing quotes, arranging an appointment or reservation, and rescheduling or following up on an existing arrangement. These share one task model and conversation engine. The product is general across these tasks; it does not promise unrestricted execution of arbitrary requests.

Initial users are individuals and small operators who would otherwise make several calls, repeat requirements, compare incomplete answers, and chase a decision. Demand remains a hypothesis until people delegate real tasks and return to use it again.

## Complete user experience

**Call and explain.** The caller speaks in Malayalam, English, or a mixture of the two. The agent extracts the desired outcome, hard requirements, preferences, deadline, location, budget, and permitted contacts. It asks only the questions needed to proceed and reads back consequential numbers and dates.

**Confirm the assignment.** The caller confirms the brief, whom the agent may contact, what it may disclose, and whether it may request counteroffers. A budget limit permits comparison and negotiation; it does not itself authorise a purchase or booking.

**Receive a live page.** The backend creates a durable task and sends an SMS with its private link to the confirmed number. The same link remains valid as the task progresses.

**Let the agent coordinate.** It calls the approved contacts, introduces itself as an AI assistant acting for the owner, collects answers, and records offers and missing information. It contacts suppliers sequentially in the prototype.

**Resolve the back-and-forth.** If a supplier asks a question the agent cannot answer, the task shows that exact question and who asked it. The owner answers on the page or calls back. The agent resumes with the same supplier and relevant context. It may request a revised offer within the owner's confirmed limits.

**Approve exact terms.** The page presents the proposed supplier, scope, total charges, upfront payment, timing, and conditions. The owner approves that specific version. The agent then seeks the supplier's confirmation.

**Keep the outcome.** The page records what was accepted, by whom, when, and any remaining action. A quote-only task finishes when the requested information is delivered, without requesting a booking. “Arrangement confirmed” means the arrangement was agreed; it does not claim that the service has already been delivered.

### Example of useful coordination

A caller needs 100 flyers delivered before Friday, with a maximum total cost of ₹2,500. One printer needs the size; another quotes ₹2,200 before a ₹400 delivery charge. The agent asks the owner for the size, resumes the first conversation, and asks the second printer whether delivery can be included within the limit. It returns comparable offers, obtains approval, and confirms the selected arrangement. If the printer later changes the price or deadline, the owner sees a new decision instead of an outdated confirmation.

The same loop must work for a technician appointment and a pickup rescheduling request. Printing is a demonstration scenario, not a product restriction.

## First release requirements

| Area | Required behaviour |
| --- | --- |
| Voice intake | Preserve the caller's meaning while making the request concise. Keep hard requirements separate from preferences. Mark uncertain quantities, names, dates, and amounts as unresolved. |
| Task continuity | Persist the brief, revisions, contacts, call attempts, offers, questions, approvals, and outcome. Refreshing the page or restarting the worker must preserve progress. |
| Returning caller | Authenticate before disclosing task details or accepting changes. Resume the active task; when several tasks exist, ask which one. Caller ID alone is insufficient identity proof. |
| Contact scope | Prototype contacts are supplied or selected by the owner. Record permission to contact them. Never invent a supplier, phone number, or completed conversation. |
| Back-and-forth | Attribute each question to its source. Preserve the answer and resume the appropriate conversation. A change to the request creates a new revision and marks affected offers for rechecking. |
| Offer comparison | Record specification, availability, deadline, base price, fees, taxes when stated, deposit, upfront amount, and conditions. Unknown charges remain unknown. Explain any violation of a hard requirement. |
| Negotiation | Ask for a better price or acceptable timing only within recorded bounds. Do not change quantity, quality, timing, or other hard requirements without permission. Keep the owner's private maximum budget confidential unless disclosure is authorised. |
| Approval | Bind approval to the authenticated owner, task revision, supplier, offer version, and material terms. Repeated clicks must not create duplicate commitments. |
| Confirmation | Require explicit supplier acceptance of the approved terms and retain its source event. A connected call, quote, tentative response, or mandatory unpaid deposit is not unconditional confirmation. |
| Notifications | Send the initial link and updates that need the owner or report an outcome. Record delivery status and failure. A notification failure must not lose or duplicate the task. |
| Stop and cancel | Stop queued actions immediately. Show any in-flight call. An already accepted arrangement requires a separate cancellation request and supplier response. |

## Live task page and interaction design

Use a single reusable mobile-first page. The initial screen answers three questions: What is happening? What needs me? What has been agreed?

- **Header:** short task title, plain-language status, and last update.
- **Your request:** concise brief with an Edit request action; detailed constraints expand on demand.
- **Current action:** one prominent question, approval, or next step. Present the exact consequence of approval.
- **Options:** compact comparable offers, including total cost, upfront amount, timing, conditions, and missing details.
- **Progress and outcome:** factual events and final agreed terms. Call notes and transcripts remain collapsed by default.

Use ordinary action labels such as Answer question, Ask for a better offer, Approve these terms, and Stop task. Show readable text, generous spacing, a neutral background, dark text, and one restrained accent colour. Status must remain understandable without colour. Avoid an analytics dashboard, decorative charts, and a large transcript as the default view.

Create the page automatically from task data. Start with a stable path such as `/t/<opaque-id>`. Add optional task subdomains on an owned domain when wildcard routing and HTTPS are configured; both addresses must resolve to the same task. Do not create a new deployment or let a model generate application code for every request. A subdomain does not replace authentication. [Wildcard DNS documentation](https://developers.cloudflare.com/dns/manage-dns-records/reference/wildcard-dns-records/).

## Task states and rules

| State | Meaning and next transition |
| --- | --- |
| Draft | The brief or contact permission is incomplete. No outbound work starts. |
| Working | The agent is contacting people, collecting information, or pursuing an authorised counteroffer. |
| Needs you | A missing fact, material change, or exact offer needs an owner response. An answer resumes work; approval moves to confirmation. |
| Awaiting confirmation | The owner approved specific terms and the agent is waiting for supplier acceptance. |
| Awaiting required action | A condition such as an unpaid mandatory deposit remains. Show the condition and responsible person. |
| Completed | The requested information or quote comparison was delivered. No booking is implied. |
| Confirmed | The supplier explicitly accepted the current approved terms and no prerequisite to confirmation remains. |
| Needs reconciliation | A late acceptance or in-flight commitment conflicts with a stop or revision. Preserve the evidence and resolve the external commitment with the owner. |
| Blocked | Contacts are exhausted, information is unavailable, or the task needs an unsupported action. Explain what would unblock it. |
| Stopped | Unsent work is halted. Preserve outstanding external commitments and their cancellation status. |

Call-attempt status and task status are separate. A late webhook must update the correct attempt without reinstating an obsolete offer. Preserve any late acceptance as evidence of a potentially outstanding external commitment and show Needs reconciliation when it conflicts with a stop or revision. Material changes invalidate approval for new commitments; historical commitments remain recorded.

For rescheduling, store the existing arrangement reference, accepted terms, and amendment status separately from the requested changes. The original arrangement remains in force until the counterparty explicitly accepts its amendment or cancellation. An offered alternative slot alone does not amend it.

## Implementation contract

Proposed components: a mobile web app, a backend with durable relational storage, a durable action queue, Sarvam voice integration, and an SMS delivery adapter. Keep provider credentials server-side. The language model proposes structured actions; the backend validates identity, permissions, constraints, current versions, and action limits before execution.

Sarvam's [API tools](https://docs.sarvam.ai/voice-agents/build/tools/https-tool) can call the backend during a conversation. Its [outbound call API](https://docs.sarvam.ai/voice-agents/api/instant-outbound/create) starts a call, while the [completion webhook](https://docs.sarvam.ai/voice-agents/api/instant-outbound/webhook-payload) reports its outcome. Our backend must implement the coordination workflow. Treat recipient statements and transcripts as task data; they cannot alter the owner's permissions or the agent's operating instructions.

### Minimum records

- **Task:** owner, brief revision, language, outcome, completion mode (information or arrangement), hard constraints, preferences, deadline with timezone, contact permissions, negotiation limits, current state, and any existing arrangement reference with its accepted terms and amendment status.
- **Participant:** role, verified contact details, permitted disclosures, and consent where needed.
- **Call attempt:** task and participant IDs, action ID, provider attempt ID, requested purpose, timestamps, actual outcome, and source notes.
- **Question and offer:** source participant, task revision, structured facts, unresolved fields, version, validity, and supporting event.
- **Approval:** owner, task revision, offer version, material terms, timestamp, and validity.
- **Event and notification:** append-only event identity, resulting state, delivery channel, delivery outcome, and retry status.

Expose backend operations for creating a draft, confirming a brief, answering a question, revising a request, scheduling an allowed call, recording an offer, requesting approval, approving terms, recording confirmation, and stopping work. The browser reads a task view built from these records.

Deduplicate provider callbacks by provider and attempt/event identity. Use durable unique action keys for call dispatch, approval handling, and notifications. If an outbound request times out after possible provider acceptance, reconcile it before retrying; do not blindly create a second call. Validate webhook authenticity using the provider's supported mechanism and never place secrets in task links.

Immediately before communicating a commitment, the agent must recheck current approval, task revision, offer version, and stop status through the backend. Dispatch-time validation alone is insufficient. If an external acceptance arrives after a stop or material revision, record it and request reconciliation rather than claiming the commitment was cancelled.

Use verified phone ownership or an equivalent authenticated session for private task access and approval. Exclude private details from link previews. Limit each supplier's access to information needed for their part of the task. Support deletion of task data and avoid retaining raw audio unless it is needed for the agreed product experience.

## Delivery channels and prerequisites

SMS is the initial link and update channel. Provision a suitable messaging sender and delivery credentials separately from voice calling. Validate the actual destination and delivery route before the demo. [SMS integration documentation](https://www.twilio.com/docs/messaging/tutorials/how-to-send-sms-messages).

WhatsApp is conditional. Meta restricts general-purpose AI assistants, and India is absent from its currently listed permitted markets. Eligibility for notification-only use by this product must be confirmed before enabling it. If eligible, obtain opt-in and use approved templates when no WhatsApp customer-service window is open. An ordinary cellular call must not be treated as opening that window. [AI provider rules](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing/ai-providers/) · [Messaging policy](https://business.whatsapp.com/policy) · [Service windows](https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/send-messages).

Check telephony access at the start. Sarvam number rental requires approved KYC; an already provisioned number avoids that dependency during the build. [Number rental documentation](https://docs.sarvam.ai/voice-agents/deploy/telephony/rent-from-sarvam). The deployment must also expose authenticated webhook endpoints reachable by the providers.

## Overnight prototype and build order

The 12-hour scope is a planning budget, conditional on working provider access. Build one active task per verified demo caller, two preconfigured consenting counterparties, sequential calls, one counteroffer round per supplier, exact owner approval, and final supplier confirmation. Cap each task at six outbound attempts including retries and confirmation calls. An exhausted limit produces a visible blocked state.

- **Hours 0–1:** verify inbound and outbound calling, webhook reachability, SMS delivery, and a durable store. Establish explicitly labelled simulation mode if an external dependency is unavailable.
- **Hours 1–4:** implement task records, revisions, state transitions, the private live page, and a structured intake flow.
- **Hours 4–7:** connect real calls, collect offers, surface supplier questions, accept owner answers, and resume the conversation.
- **Hours 7–9:** implement exact approval, confirmation, critical notifications, stop controls, and restart-safe event handling.
- **Hours 9–12:** run the end-to-end scenario and failure cases below, refine the mobile page, and rehearse the demonstration.

Defer supplier discovery, payment execution, account creation at third parties, calendar integrations, automatic recurring tasks, team collaboration, and unrestricted purchasing. Task subdomains and WhatsApp may follow the working phone and page loop. Keep the data model compatible with multiple tasks even though the demo uses one active task per caller.

## Acceptance and validation

The prototype passes only when:

- A natural Malayalam and English request becomes a caller-confirmed brief without guessing consequential facts.
- The live page survives refresh and backend restart with the same task, offers, and decisions.
- A supplier asks a question, the owner answers, and the agent resumes the correct conversation with that answer.
- An excluded delivery fee or missed hard deadline makes an offer visibly unsuitable until resolved.
- The agent obtains a counteroffer without silently relaxing hard requirements.
- Changed terms invalidate an earlier approval, including when the change arrives after the owner clicks Approve.
- Duplicate callbacks and repeated approvals create no duplicate commitment; an uncertain dispatch is reconciled before retry.
- Confirmation is supported by an actual counterpart response. An unpaid mandatory condition remains visible.
- Failed calls and SMS delivery failures produce truthful statuses and a recoverable next step.
- Stopping prevents new queued work and accurately describes any existing external commitment.
- Another user cannot read the task or approve it by changing a URL or task ID.
- The same core workflow handles a quote request, an appointment, and a rescheduling example without task-specific page code.
- A quote-only request reaches Completed without being pushed into a booking or purchase.
- Rescheduling preserves the original arrangement until its amendment is explicitly confirmed by the counterparty.
- A stop or revision during a call prevents any new commitment when the agent rechecks authority; a late acceptance is preserved and shown as Needs reconciliation.

Use a recorded or clearly labelled simulated scenario for repeatable judging only when appropriate. Count only real provider calls and independently confirmed counterpart responses as validation of live coordination.

For initial product validation, try six real tasks across the three task types. Measure verified outcomes, active owner time, number of interventions, errors, and voluntary repeat use. A proposed continuation gate is at least four tasks reaching their requested outcome, zero unauthorised commitments, and at least three participants choosing to delegate another task. These are experiment targets, not proven success rates. The strongest failure signal is that owners still perform the calls, comparisons, and follow-up themselves.
