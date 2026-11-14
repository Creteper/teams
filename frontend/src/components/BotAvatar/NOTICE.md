# BotAvatar — provenance

- Original implementation. No code was copied from
  `ArvinYin1/grokbot-animation-anatomy` (that repository has no LICENSE file;
  its README says "MIT" but the engine port and extracted data it contains are
  derived from the Grok Bot app and stated to remain the property of their
  owners). Only the published *principles* were used as reference: procedural
  SVG outlines (superellipse / rounded polygon / circle union), cut-out eyes,
  springs integrated with fixed-step semi-implicit Euler, eyes mapped onto a
  sphere and projected orthographically, 0.26 s blinks shut at 45 %.
- The colour ids and hex values in `colors.ts` follow the palette documented in
  grok-bot-sdk (https://github.com/RongleCat/grok-bot-sdk):


```text
MIT License

Copyright (c) 2026 RongleCat

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

- Grok / Grok Bot names and the avatar design belong to their owners.
