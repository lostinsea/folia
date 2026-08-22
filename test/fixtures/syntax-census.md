# Syntax ground truth

```javascript
import fs from 'fs';
// a comment
const RE = /ab+c/gi;
export default async function main(a, b = 42) {
  const obj = { key: 'value', flag: true, n: 0x1f };
  return await fs.promises.readFile(`./x${a}`) ?? null;
}
class Widget extends Base { get size() { return 1; } }
```

```python
import os
# comment
@decorator
def fn(x: int = 3) -> str:
    return f'{x!r}' if x else None
```

```css
@media print { .a > b#c[d='e'] { color: #fff; margin: 0 !important; } }
.bg { background: url("img.png") no-repeat; }
```

```html
<?xml version="1.0"?>
<!DOCTYPE html>
<a href="x" data-y='z'>text &amp; more &lt;here&gt;</a>
<ns:widget xmlns:ns="urn:x" ns:attr="v">&copy;</ns:widget>
<![CDATA[raw]]>
<!-- c -->
```

```json
{ "a": [1, true, null], "b": "s" }
```

```sql
SELECT COUNT(*) AS n FROM t WHERE a = 'x' AND b > 1; -- note
```

```bash
#!/usr/bin/env bash
function build() { echo "$1"; }
helper() { :; }
grep -r "$HOME" . | awk '{print $1}' && echo done
```

```typescript
interface P<T> { readonly id: number; name?: string }
enum E { A = 1 }
const f = <T,>(x: T): T => x;
```

```java
public class A { private static final int N = 7; }
```

```csharp
namespace N { public class C { public string S => "v"; } }
```

```c
#include <stdio.h>
int main(void) { char c = 'x'; printf("%d\n", 1); return 0; }
```

```cpp
template <typename T> struct S { T v; };
```

Inline `code span` and a [link](https://example.com).

Inline highlighted code: <code class="language-javascript">const x = 1;</code> —
this is NOT a hypothetical. `class` is in the sanitizer's ADD_ATTR
(src/renderer.js), so raw HTML like this survives DOMPurify and renders as a
`code[class*="language-"]` that is NOT inside a `<pre>`. PrismJS supports that
shape deliberately, which is why its themes ship a
`:not(pre) > code[class*="language-"]` rule. It is measured because it is the
one code surface whose box comes from a DIFFERENT set of rules than the block
form, so `pre`/`pre code` cannot stand in for it.

## Reading surfaces

> A blockquote line.

| Head | Other |
|---|---|
| a | b |
| c | d |

A code block with no author-supplied language:

<pre id="census-nolang"><code>plain preformatted text
no language class anywhere</code></pre>

Raw HTML, so marked emits it verbatim and DOMPurify keeps `pre`/`code`. The
author adds no `language-*` class - but PrismJS DOES, at highlight time: its
core normalises a missing language to `none` and stamps `language-none` on both
the `code` and its parent `pre`. Measured on this very element, settled: with
the class present the light `pre` is cream and its `code` transparent, while the
dark `pre` and `code` are BOTH `#2d2d2d`; with the class stripped, both `pre`
elements paint nothing and only the dark `code` still carries `#2d2d2d`.

So in the first case the dark `code` background is a duplicate of the `pre`
behind it and is not visible - what the golden pins there is byte-exact
fidelity, not appearance. The stripped case is where
`body.dark-mode .markdown-body code` was load-bearing: with no `language-*`
class the dark `pre` paints nothing and the `code` background is the only panel
there is. That state is reached transiently on every full render before Prism
runs, and permanently in the `typeof Prism === "undefined"` fallback path.