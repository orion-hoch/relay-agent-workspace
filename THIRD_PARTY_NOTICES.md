# Third-party source attribution

Shoal includes the PageHeader component from [Block, Inc. — Buzz](https://github.com/block/buzz), snapshot 6c35e82bd50f4ad6587554eeb429e7378d474ba7, under the Apache License 2.0. Original file: desktop/src/shared/ui/PageHeader.tsx. The local utility import path was adapted. A copy of the license is in licenses/buzz-Apache-2.0.txt.

The adapted ChatHeader retains the title/action hierarchy from desktop/src/features/chat/ui/ChatHeader.tsx; native app services were omitted.

The sidebar, conversation layout, chooser spacing, and typography also follow Buzz's source and channel screenshots, with a monochrome palette requested by the user. Application state, Data, Compute, and standalone frontend behavior are implemented separately.

The Agents screen adapts markup and layout from Buzz desktop/src/features/agents/ui/AgentsView.tsx, UnifiedAgentsSection.tsx, AgentIdentityCard.tsx, CreateIdentityCard.tsx, and TeamsSection.tsx. State, forms, local/cloud configuration, and custom agent avatars were adapted to this standalone frontend.

Geist and Geist Mono are bundled through the `geist` package so builds do not fetch fonts. Their font license is retained in the installed package. The compute artwork supplied with this project is retained from the existing design.

The searchable emoji catalogue in `lib/emoji-data.json` is derived from Unicode Emoji 17.0 [emoji-test.txt](https://www.unicode.org/Public/emoji/17.0/emoji-test.txt), using fully-qualified sequences and their names. Copyright © 2025 Unicode, Inc. Distributed under the Unicode License v3, included in `licenses/Unicode-3.0.txt`. Emoji render with the device’s fonts.
