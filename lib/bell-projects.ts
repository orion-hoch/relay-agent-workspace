// Fictional Shell program briefs. Task completion is calculated from the shared store.
export const bellProjects = [
  {
    "id": "summit-r8",
    "name": "Summit R8 Server Platform",
    "code": "SUM-R8",
    "ownerId": "olivia",
    "agentIds": [
      "atlas",
      "sage",
      "ledger"
    ],
    "status": "In progress",
    "progress": 72,
    "dueDate": "2026-09-24",
    "classification": "Confidential",
    "description": "Qualify a fictional 2U enterprise rack server for virtualization, private AI inference, and branch infrastructure.",
    "goal": "Clear DVT entry with a frozen power budget, verified recovery path, and launch supply coverage.",
    "nextGate": "DVT entry review \u00b7 September 24",
    "risk": "Cedar alternate PSU remains unqualified; launch supply covers 65% of the planned build."
  },
  {
    "id": "horizon-14",
    "name": "Horizon 14 Mobile Workstation",
    "code": "HOR-14",
    "ownerId": "marcus",
    "agentIds": [
      "nova",
      "iris",
      "sage"
    ],
    "status": "At risk",
    "progress": 64,
    "dueDate": "2026-09-19",
    "classification": "Confidential",
    "description": "Validate a fictional 14-inch engineering notebook for sustained CAD workloads, docking reliability, and quiet operation.",
    "goal": "Pass the 28 W sustained thermal profile and close the repeatable dock-resume defect before design validation signoff.",
    "nextGate": "Thermal and docking signoff \u00b7 September 19",
    "risk": "Fan curve B misses the skin-temperature limit by 0.3\u00b0C; dock mitigation needs a larger confirmation run."
  },
  {
    "id": "compass-34",
    "name": "Compass 3.4 Fleet Firmware",
    "code": "CMP-34",
    "ownerId": "olivia",
    "agentIds": [
      "atlas",
      "iris",
      "sage"
    ],
    "status": "Blocked",
    "progress": 81,
    "dueDate": "2026-09-18",
    "classification": "Restricted",
    "description": "Prepare a fictional unified firmware release with guarded promotion, dual-bank recovery, and auditable compatibility checks.",
    "goal": "Close FW-27 and verify power-loss recovery before promotion from the 40-system lab ring to the 250-system pilot.",
    "nextGate": "Pilot promotion decision \u00b7 September 18",
    "risk": "Security regression evidence and the remaining 50 interrupted-update cycles are outstanding."
  },
  {
    "id": "cedar-power",
    "name": "Cedar Efficient Power Program",
    "code": "CED-PSU",
    "ownerId": "you",
    "agentIds": [
      "nova",
      "ledger",
      "scout"
    ],
    "status": "In review",
    "progress": 58,
    "dueDate": "2026-09-22",
    "classification": "Restricted",
    "description": "Qualify a fictional 1,200 W redundant PSU option and balance launch availability, efficiency, acoustics, and sourcing cost.",
    "goal": "Approve a production power configuration and a supply plan for 4,000 Summit R8 systems.",
    "nextGate": "Qualification and sourcing review \u00b7 September 22",
    "risk": "PSU-B meets efficiency targets but has a hold-up-time miss at high ambient temperature."
  }
];
