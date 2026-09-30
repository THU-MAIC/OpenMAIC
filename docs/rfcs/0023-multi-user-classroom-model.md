# RFC: Multi-user identity and classroom sharing

- **Status:** Draft
- **Related:** [Issue #23](https://github.com/THU-MAIC/OpenMAIC/issues/23), [Issue #1658](https://github.com/THU-MAIC/OpenMAIC/issues/1658), [Issue #1639](https://github.com/THU-MAIC/OpenMAIC/issues/1639)
- **Audience:** OpenMAIC core maintainers and deployment integrators

## Summary

OpenMAIC is moving from a single-browser classroom model toward a model in
which a classroom has an owner, optional collaborators or viewers, and a
durable identity behind every server-side write.

This RFC records the identity and classroom-ownership model used by a school
deployment and proposes the smallest set of general-purpose contracts for
OpenMAIC core. Authentication protocol, institution-specific roles, class
rosters, and learning-event delivery remain deployment concerns unless they
are needed by more than one integration.

The proposal is intentionally incremental. The owner/identity seam in #1658
and the shared-owner option in #1639 are the foundation. Classroom sharing,
roster publication, and learning events can be added as independently
reviewable layers on top of that foundation.

## Motivation

A classroom URL is currently enough to identify a course in the browser, but
an application that serves multiple people needs more precise answers:

- Who owns a classroom and may edit or delete it?
- How can an owner share a classroom without exposing private drafts?
- How can a teacher publish a roster without making every account an owner?
- Which learner activity belongs to which person, class, or deployment?
- How can an installation use OAuth, SSO, or a gateway identity without
  forking every route that writes data?

A school deployment can answer these questions through its authentication and
deployment-specific services. The OpenMAIC core currently provides the
owner/identity and owner-scoped persistence seams described below; classroom
sharing grants, school roster publication, and learning-event analytics are
not yet general-purpose core capabilities. The goal of this RFC is to separate
the reusable contracts from deployment policy and infrastructure.

## Terminology

| Term | Meaning |
| --- | --- |
| **Principal** | The identity resolved for one request. It has an opaque owner ID, subject kind, roles, and assurance. |
| **Owner** | The storage boundary for a user's or deployment's durable data. A classroom has exactly one canonical owner. |
| **User** | A verified human identity supplied by an authentication method, such as OAuth or SSO. |
| **Anonymous owner** | A browser/device-scoped identity used before sign-in. It can be claimed by a verified user. |
| **Learner** | The person whose runtime progress and activity are recorded. A learner may view a classroom without owning it. |
| **Roster** | The deployment's membership and teaching context for a classroom or class. It is not the same as storage ownership. |
| **Viewer** | A principal allowed to read a published or explicitly shared classroom. |

Owner and learner IDs must not be inferred from URL parameters or client-
supplied headers. A request resolves its principal through the configured
identity seam; learner partitioning is then derived from the authenticated
identity and the classroom policy.

## Current core foundation

The current server persistence implementation already has several useful
properties:

1. Owner-scoped routes resolve a principal through one identity resolver. An
   `OwnerPrincipal` carries an opaque `ownerId`, `kind`, `roles`, and
   `assurance`; authentication methods are registered by the deployment.
2. Documents, folders, materials, agent sessions, skills, runtime sessions,
   and assets are scoped to an owner. The course companion table
   `stage_meta` records `stage_id`, `owner_id`, publication state, generation
   state, and tombstones.
3. Anonymous browser work can be claimed after sign-in. A claim re-keys the
   registered owner-scoped stores in one transaction and retires the anonymous
   owner, so the same work is not copied into two accounts.
4. Publishing is owner-only and role-gated by `course:publish`. Anonymous
   owners cannot publish a durable public course.
5. A deployment may opt into one shared owner for a single-tenant instance.
   This is useful for a trusted classroom or kiosk deployment, but it is not a
   substitute for multi-user authorization.

These seams should remain the core integration points. A host should register
an authentication method and policy rather than patching every persistence or
stage route.

### Implemented in the school deployment

The school deployment has working features built on top of these core seams:

- OAuth login and school-specific roles;
- classroom sharing and access controls;
- roster publication and class membership;
- learning-event collection for school reporting.

These are deployment-level implementations, not capabilities currently
provided by the OpenMAIC core. The core-side work that is already present is
the pluggable owner authentication contract, owner-scoped persistence,
anonymous-to-account owner claims, single-tenant shared-owner mode, and basic
owner- and role-gated classroom publication. The RFC's proposed grant model,
portable roster contract, and learning-event delivery boundary would make
selected parts of the school implementation reusable without bringing
school-specific OAuth, roles, or reporting policy into core.

## Proposed core model

### Identity

Core should keep identity opaque and deployment-provided:

- `OwnerAuthMethod` resolves a request to an `OwnerPrincipal`.
- `ownerId` is stable, printable, and never derived from a display name.
- `kind` distinguishes anonymous, user, device, shared, and service
  principals.
- `roles` are request-time capabilities. Core defines only roles needed by
  core behavior, such as `course:publish`; deployments may add roles.
- `assurance` lets a deployment distinguish verified credentials from legacy
  or minted identities without making core understand its token format.

OAuth, SAML, LDAP, campus directory lookup, session renewal, and group
membership mapping belong in an authentication adapter. The adapter may map
institutional claims to core roles, but core should not depend on a particular
identity provider.

### Classroom ownership

Each classroom has one canonical owner. Ownership controls the private
document and its mutable metadata. A classroom ID is never itself an
authorization credential.

The minimum owner policy is:

| Operation | Owner | Shared editor | Viewer | Anonymous |
| --- | --- | --- | --- | --- |
| Read private draft | yes | policy-dependent | no | no |
| Edit scenes and actions | yes | policy-dependent | no | no |
| Publish/unpublish | role-gated | role-gated | no | no |
| Read published classroom | yes | yes | yes | yes, if public policy allows |
| Delete classroom | yes | no by default | no | no |

Sharing should grant access to an explicit principal or deployment-defined
group. A public link is a read capability for the published artifact, not an
edit capability and not proof of ownership. The first core implementation can
support read-only published sharing; collaborative editing can follow once
conflict and audit semantics are defined.

### Anonymous-to-account transition

An anonymous browser may create a draft before login. After authentication,
the deployment can invoke the existing claim seam to move that browser's
owner-scoped work to the verified account. The claim must be:

- transactional across registered participants;
- idempotent for retries and multiple tabs;
- one-way, so the anonymous owner cannot later be claimed by a second account;
- explicit about which host-owned tables participate.

Deployments that do not support anonymous work may disable the anonymous
fallback and require a verified principal before creating a classroom.

## Classroom sharing and publication

The core should distinguish three states:

1. **Private:** only the owner and explicitly authorized collaborators can
   read or mutate the document.
2. **Shared:** named principals or deployment groups can read, and optionally
   edit, according to a grant. The owner remains the canonical owner.
3. **Published:** the owner has created a durable public artifact. Public
   readers get a read projection; private chats, runtime state, materials,
   and edit history remain owner-scoped.

A future share-grant relation can be modeled as:

```text
classroom_grants(
  stage_id,
  subject_kind,
  subject_id,
  permission,       -- view | edit
  granted_by,
  created_at,
  revoked_at
)
```

This is a proposal, not a request to add the table immediately. The first
small PR should establish a read-only access resolver and use it consistently
for published classroom reads. Editing grants should be added only with an
explicit conflict strategy, audit requirements, and tests for revocation.

## Roster publication

A roster describes who teaches or learns in a classroom. It must not be used
as a replacement for document ownership:

- the owner controls the classroom document;
- a teacher role may manage the roster if the deployment grants it;
- a learner may be rostered without gaining document edit access;
- roster membership may be time-bounded and should support revocation;
- a published classroom may expose only the roster fields intended for
  learners, not private identity claims.

The school deployment stores a classroom roster alongside the stage and uses
it to bind teaching agents, voices, and class membership. The portable core
contract should keep roster data deployment-neutral: stable subject IDs,
role, enrollment status, and effective dates. Campus-specific student numbers,
course codes, and directory attributes belong in the adapter or a separate
integration table.

## Learning events and statistics

Learning activity should be recorded separately from classroom ownership and
from the document JSON. A minimal event envelope is:

```text
{
  "eventId": "unique-id",
  "occurredAt": "ISO-8601 timestamp",
  "actorId": "opaque learner or user id",
  "stageId": "classroom id",
  "sessionId": "optional runtime/session id",
  "eventType": "scene_viewed | action_completed | quiz_submitted | ...",
  "payload": { "...": "event-specific data" },
  "schemaVersion": 1
}
```

Core should provide a typed event boundary and delivery hooks, with bounded
payloads and stable identifiers. Retention, warehouse choice, consent,
anonymization, export, and institution-specific dashboards belong to the
deployment. Events should be append-only from the learner-facing path and
should not be allowed to mutate classroom ownership.

The existing owner/session event infrastructure can carry owner-scoped
operational events. It should not be assumed to be a complete learning
analytics warehouse; a separate event participant or sink is preferable when
institutional reporting is required.

## Core versus deployment-specific responsibilities

| Concern | OpenMAIC core | Deployment adapter |
| --- | --- | --- |
| Request principal resolution | `OwnerAuthMethod`, `OwnerPrincipal`, owner resolver | OAuth/SSO/gateway implementation |
| Owner-scoped persistence | document, runtime, asset, session boundaries | Database provisioning and tenancy policy |
| Anonymous claim | Transactional claim seam and participants | When and how login is required |
| Roles | Small core vocabulary such as `course:publish` | Campus roles, groups, instructor/student mapping |
| Sharing | Access resolver and safe public projection | Group sync, invitation workflow, external ACLs |
| Roster | Portable subject/role/enrollment contract | SIS integration and campus identifiers |
| Learning events | Event envelope and delivery seam | Consent, retention, warehouse, dashboards |
| Single-tenant shared owner | Opt-in core mode | Operator's decision to enable it |

## Migration and compatibility

The migration path should preserve existing single-user installations:

1. Keep anonymous/browser persistence working when no host authentication is
   configured.
2. Add owner metadata beside existing documents and backfill it transactionally.
3. Resolve legacy documents to the configured shared or single owner according
   to an explicit operator choice; never guess a user's identity from a URL.
4. Enable verified identity methods without changing the document DSL.
5. Claim anonymous work on sign-in where the deployment supports it.
6. Add sharing and event tables only after their access and retention policies
   are defined.

An installation must be able to roll back an adapter independently of the
document format. Owner claims and publication changes need durable audit logs
or equivalent operational records before being used for high-stakes data.

## Suggested implementation slices

These slices are intentionally small and independently reviewable:

1. **Document the seam:** finalize the `OwnerPrincipal` and authentication
   adapter contract, with conformance tests for anonymous, verified, invalid,
   and shared principals.
2. **Owner access resolver:** centralize private, published, and tombstoned
   classroom reads; add tests that distinguish ownership from possession of a
   classroom ID.
3. **Read-only sharing:** add explicit viewer grants or a deployment hook for
   group viewers, with revocation and no-edit guarantees.
4. **Roster contract:** define a portable roster record and owner/teacher/
   learner authorization checks; keep SIS synchronization out of core.
5. **Learning-event seam:** define the event envelope, append boundary,
   retry/idempotency behavior, and a no-op sink for browser-only deployments.
6. **Collaborative editing:** only after access grants, conflict handling,
   audit, and offline behavior are specified.

Each slice should include route-level authorization tests and a deployment
adapter example. No slice should require a particular OAuth provider or
institutional database schema.

## Open questions

- Should a public classroom read use the owner’s document projection directly,
  or a separately materialized published snapshot?
- Should viewer grants be principal IDs only, or also stable deployment group
  IDs supplied by an adapter?
- Which runtime state is private to a learner, shared with a teacher, or safe to
  include in aggregate analytics?
- What event retention and deletion guarantees are required for deployments
  handling minors or regulated education data?
- Should collaborative editing use optimistic revisions, an operation log, or
  a higher-level merge protocol?
- How should a learner's identity be represented when the same person uses
  multiple deployments or a classroom link without signing in?

## Non-goals

This RFC does not choose an OAuth vendor, define a campus SIS integration,
design a complete analytics warehouse, or make all classrooms collaborative.
It also does not require a schema migration before the owner/identity seam
and access boundaries are agreed upon.
