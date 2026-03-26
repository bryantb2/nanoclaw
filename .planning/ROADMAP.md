# Roadmap: NanoClaw Agent Fleet

## Overview

NanoClaw is a lightweight, single-process AI agent system running Claude in isolated containers. This roadmap tracks the phased rollout from initial setup through advanced agent capabilities for the Fleet PM use case.

## Phases

- [x] **Phase 01: Setup** - Initial installation, Slack registration, service configuration
- [x] **Phase 02: Core Agent** - KICKOFF execution, T1-T13 validation, end-to-end pipeline confirmed
- [x] **Phase 03: Operational Hardening** - T19 uploadFile IPC validated, T20 interrupt notification confirmed, deploy cron active

## Phase Details

### Phase 01: Setup
**Goal**: NanoClaw installed, Slack connected, sender allowlist configured
**Depends on**: Nothing (first phase)
**Success Criteria**:
  1. NanoClaw process running on production server
  2. Slack channels registered and responding to trigger word
  3. Sender allowlist enforced for authorized users

Plans:
- [x] 01-01: Installation and Slack skill setup

### Phase 02: Core Agent
**Goal**: All KICKOFF steps implemented and validated through T1-T13 test suite
**Depends on**: Phase 01
**Success Criteria**:
  1. All 11 KICKOFF steps running in production
  2. Fleet PM identity active with correct Slack formatting
  3. Linear + GitHub integrations working end-to-end
  4. T1-T13 test suite: 11/13 full pass (T6, T9 partial — documented)

Plans:
- [x] 02-01: KICKOFF execution (all 11 steps + post-KICKOFF fixes)
- [x] 02-02: T1-T13 validation (11 full pass, 2 partial)

### Phase 03: Operational Hardening
**Goal**: Validate deferred Phase 02 items in production, confirm automated deploy pipeline
**Depends on**: Phase 02
**Success Criteria**:
  1. T19: uploadFile IPC triggers correctly with real file-producing task — PASS
  2. T20: Interrupt notification posted on NanoClaw restart — PASS
  3. deploy.sh cron confirmed at 5 AM daily — PASS

Plans:
- [x] 03-01: Deploy cron setup (post-hoc — executed on production server)
- [x] 03-02: T19 + T20 validation (uploadFile IPC, interrupt notification)

## Progress

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 01. Setup | 1/1 | Complete | 2026-03-25 |
| 02. Core Agent | 2/2 | Complete    | 2026-03-25 |
| 03. Operational Hardening | 2/2 | Complete    | 2026-03-25 |
| 03.1. Polish + Hardening TODOs | 3/3 | Complete    | 2026-03-26 |

### Phase 03.1: Polish and Hardening TODOs (INSERTED)

**Goal:** Ship deferred polish items: Slack threading, cost tracking, Linear OAuth bot persona
**Requirements**: TBD
**Depends on:** Phase 3
**Plans:** 1/1 plans complete

Plans:
- [x] 03.1-01: Slack threading + emoji reaction + cost tracking (feat commits only, no plan file)
- [x] 03.1-02: Engineering standards + QA policy + display conventions added to CLAUDE.md
- [x] 03.1-03: Linear bot identity (fleet@krewtrack.com workspace member) + bot persona instructions in CLAUDE.md
