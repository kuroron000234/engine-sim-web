# Third-party notices

The WebAssembly build (`web/engine.wasm`, `web/engine.js`, `web/engine.data`) is compiled from
and bundles the following projects. Their source is not copied into this repository;
`native/build.sh` downloads it and `native/patch_upstream.py` applies small portability fixes.

| Component | What is used | Author | License |
|---|---|---|---|
| [engine-sim](https://github.com/ange-yaghi/engine-sim) @ `85f7c3b` | Simulation, synthesizer, scripting bindings (`src/`, `include/`, `scripting/`), engine scripts and impulse responses (`es/`, `assets/`) | Ange Yaghi (AngeTheGreat) | MIT |
| [piranha](https://github.com/ange-yaghi/piranha) | `.mr` scripting language compiler | Ange Yaghi | MIT |
| [simple-2d-constraint-solver](https://github.com/ange-yaghi/simple-2d-constraint-solver) | Rigid-body / constraint solver | Ange Yaghi | MIT |
| [Emscripten](https://emscripten.org/) | JavaScript runtime glue in `engine.js`, libc++/musl | Emscripten authors | MIT / University of Illinois NCSA |
| [flex](https://github.com/westes/flex) | Generated lexer code in the scripting compiler | Vern Paxson et al. | BSD-style (flex license) |
| [GNU Bison](https://www.gnu.org/software/bison/) | Generated parser code | FSF | GPL with Bison exception (no restrictions on generated output) |

## engine-sim, piranha, simple-2d-constraint-solver

```
Copyright 2022 AngeTheGreat (Ange Yaghi)

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

## flex

```
Copyright (c) 2001, 2002, 2003, 2004, 2005, 2006, 2007 The Flex Project.
Copyright (c) 1990, 1997 The Regents of the University of California.
All rights reserved.

This code is derived from software contributed to Berkeley by Vern Paxson.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:
1. Redistributions of source code must retain the above copyright notice,
   this list of conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

Neither the name of the University nor the names of its contributors may be
used to endorse or promote products derived from this software without
specific prior written permission.

THIS SOFTWARE IS PROVIDED "AS IS" AND WITHOUT ANY EXPRESS OR IMPLIED
WARRANTIES, INCLUDING, WITHOUT LIMITATION, THE IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE.
```

## Emscripten

Emscripten is available under two licenses, the MIT license and the University of Illinois/NCSA
Open Source License. See https://github.com/emscripten-core/emscripten/blob/main/LICENSE.
