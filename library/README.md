# LDraw 官方零件库

在仓库根目录运行：

```powershell
pnpm ldraw:fetch
```

脚本通过 `scripts/devenv.mjs` 运行，下载缓存位于 `.devdata/ldraw-download/complete.zip`。固定版本在 `tools/ldraw-fetch/pin.json`：官方来源为 [complete.zip](https://library.ldraw.org/library/updates/complete.zip)，ZIP 大小 146,075,744 字节，SHA-256 为 `f3e496d0ede69ca7942fa4aa198e661ee2d22723906101e2e339d8917a4dd5f2`。

下载后必须匹配大小和 SHA-256，才会在 `.devdata/ldraw-download/` 中暂存解压，并将结果移至 `library/ldraw/`。每个 ZIP 成员校验长度、CRC 和安全相对路径。脚本只读取、校验、写出数据，不执行 `mklist.exe` 或任何库内程序。已有匹配的 VERSION 时跳过下载和解压；若对应 ZIP 缓存还在，也校验其 SHA-256。

如果已有 ZIP，或零件已解压但缺少 VERSION，使用：

```powershell
pnpm ldraw:fetch --from-zip <已有的complete.zip路径>
```

脚本逐文件核对已有库与 ZIP 的内容，再仅新增 `VERSION.json`，不会覆盖现有零件。已有文件与 ZIP 不一致、现有 VERSION 与 pin 不一致时，操作失败并保留原文件。升级需要显式选择新快照和独立目录，不会静默改成官方 URL 当前最新内容；官方 URL 将来更新后，旧 pin 需要使用已缓存的 ZIP。

当前快照的库内更新标识为 `2026-09`（扫描零件头/历史中的最大更新编号），`LDConfig.ldr` 更新日期为 `2026-05-29`。`VERSION.json` 记录 schema、来源 URL、ZIP 大小和 SHA-256、下载时间、登记时间、库更新标识、颜色配置日期和文件数。导入已有 ZIP 时，下载时间取 ZIP 的修改时间，`downloadedAtSource` 明确标为 `archive-mtime`，不将登记时间冒充实际下载时间。

```text
library/
  README.md
  ldraw/                    # 下载产物，已被 git 忽略；也可以是目录联接
    VERSION.json
    LDConfig.ldr            # 颜色定义
    parts/                  # 官方零件
      s/                    # 子零件，s/ 前缀
    p/                      # 默认图元
      48/                   # 高精度图元
      8/                    # 低精度图元
    models/                 # 示例模型
    CAreadme.txt
    CAlicense.txt           # CC BY 2.0 正文
    CAlicense4.txt          # CC BY 4.0 正文
```

CI 应先运行 `pnpm ldraw:fetch` 再运行 `pnpm verify`。完整库不进入 git；没有库时几何夹具测试仍执行，依赖官方库的尺寸和性能测试输出提示并跳过。获取脚本的网络/解压流程用本地小型假 ZIP 测试，不重复下载官方完整包。

LDraw 零件库由 **LDraw.org 及各零件文件 Author / !HISTORY 中标注的贡献者**创作；LDraw 系统由 James Jessiman 创建。库文件使用 CC BY 2.0（旧标记 CCAL 2.0）和/或 CC BY 4.0，具体以文件头的 `!LICENSE` 和随库 `CAreadme.txt` 为准。项目使用原始库文本，生成的网格为派生缓存；分发库或派生几何时保留作者与历史署名、来源、许可链接，并说明转换或修改。

来源：[LDraw.org](https://www.ldraw.org/)、[贡献者协议](https://www.ldraw.org/article/349.html)。许可：[CC BY 2.0](https://creativecommons.org/licenses/by/2.0/)、[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)。第三方登记见 [docs/third-party.md](../docs/third-party.md)。
