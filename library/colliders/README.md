# 人工碰撞代理

这些 JSON 是按公开 LDraw 几何尺寸编写的本项目代理，不来自 Studio `.col`。文件名由 `@brickloop/collide` 的 `colliderFileName(PartId)` 生成，冒号编码为 `%3A` 以兼容 Windows。JSON 内的 PartId 保留原始形式。

| 文件                       | PartId     | 版本 | 内容                                                 |
| -------------------------- | ---------- | ---: | ---------------------------------------------------- |
| `ld%3A3001.collider.json`  | `ld:3001`  |    1 | 2×4 砖：顶板、侧壁、8 个凸点、3 条中空底管。         |
| `ld%3A3020.collider.json`  | `ld:3020`  |    1 | 2×4 板：浅底腔与短底管。                             |
| `ld%3A85861.collider.json` | `ld:85861` |    1 | 1×1 开孔圆板：空心凸点、圆盘体和底管，保留贯通杆孔。 |

schema 为 1；盒 rotation 使用列主序正交 3×3 矩阵；尺寸单位为 LDU。全部形状已经至少内缩 0.5 LDU，加载时不再内缩。`approximate: false` 表示按人工定义的基本体做确定检测，不表示复原了原网格全部细节。改变形状时增加 `version`。

## M3-1b 覆盖与统计

示例包222件：有效代理222件，空代理0，近似代理 **16→0**，包内人工代理 **2→18**，自动代理204件。完整有效结果见 [demo-coverage.json](demo-coverage.json)，以优先加载人工覆盖的实际路径统计。`packages/collide/evidence/generation.json` 保留此前自动生成的历史记录，其中的16件开放表面回退已全部有覆盖。

新增16份覆盖均为schema 1、version 1、approximate false。各文件 `notes` 保存几何依据与尺寸；数字为原始LDU尺寸，JSON基本体已经内缩。

| PartId                                | 覆盖内容                       | 正确连接回归          | 错位回归 |
| ------------------------------------- | ------------------------------ | --------------------- | -------- |
| [2357](ld%253A2357.collider.json)     | L形顶板、侧壁、3凸点、2底柱    | 3024底接，y=24        | 横移10   |
| [25269](ld%253A25269.collider.json)   | 四分之一圆板、单凸点底腔       | 3024底接，y=8         | Z移8     |
| [3045](ld%253A3045.collider.json)     | 双凸斜顶、底壁、底管、顶部凸点 | 3024顶接；3022底接    | 横移8/10 |
| [3046](ld%253A3046.collider.json)     | 双凹斜顶、底壁、底管、3凸点    | 3024顶接；3022底接    | 横移8/10 |
| [43093](ld%253A43093.collider.json)   | 中空销段、根部限位、十字轴     | 32316销孔             | 横移5    |
| [3749](ld%253A3749.collider.json)     | 中空销段、根部限位、十字轴     | 32316销孔             | 横移5    |
| [56145](ld%253A56145.collider.json)   | 阶梯轮缘、六辐、轴孔           | 44309轮胎同心安装     | 横移12   |
| [55982](ld%253A55982.collider.json)   | 轮缘、腹板、轴孔、定位槽       | 30648轮胎同心安装     | 横移8    |
| [30027b](ld%253A30027b.collider.json) | 小轮缘、腹板、限位轮轴孔       | 4600轮轴座            | 横移5    |
| [60208](ld%253A60208.collider.json)   | 阶梯轮缘、7销孔、连接腹板      | 56898轮胎中心移至z=-7 | 横移10   |
| [6014a](ld%253A6014a.collider.json)   | 轮缘、中央腹板、小轮轴孔       | 4600轮轴座            | 横移5    |
| [56898](ld%253A56898.collider.json)   | 胎壁与中央定位唇，保留轮毂空间 | 60208轮毂中心移至z=7  | 横移10   |
| [32607](ld%253A32607.collider.json)   | 空心凸点、盘体、底管、叶片厚部 | 3024底接，y=8         | 横移7    |
| [30176](ld%253A30176.collider.json)   | 空心凸点、竹节、叶梗与叶片厚部 | 3024底接，y=24        | 横移7    |
| [3818](ld%253A3818.collider.json)     | 右肩袖、肩销、上臂与中空前臂   | 3820腕杆；973肩孔     | 横移4/6  |
| [3819](ld%253A3819.collider.json)     | 左手臂镜像分解                 | 3820腕杆；973肩孔     | 横移4/6  |

测试在 `packages/collide/test/demo-overrides.test.ts`：20组实件配对均验证 `none`，错位后验证 `hit`，另逐件验证全部222件代理非空且非近似。轮胎宽度标签与固定配对语义另见连接器标注记录。

为避免2 LDU体素丢失小轮轴轴壁，自动代理生成新增 `wpin.dat` 的两侧轴壁圆柱，保留中央开槽，并用真实网格内采样筛除越界圆柱。回归检查4600轴槽为空、两侧轴壁均可检测；生成器版本升至1.1.0，使既有缓存失效。普通开放表面仍保留原来的近似回退规则。

人工代理采用内接基本体：圆环保留孔径；斜面由分层盒逼近；叶片薄缘、细胎纹、齿纹和圆角没有逐面复原。0.5 LDU接触容差及基本体间隙可能忽略很浅的擦碰。没有未完成的空代理或近似代理；这些形状的保证范围是上述真实配对和明确错位回归，复杂姿态仍需后续实体/维护器审核。

原有三份文件的尺寸定义保存在 `packages/collide/scripts/write-overrides.ts`，可用下列命令重建并格式化这三份文件（不生成M3-1b新增的16份）：

```powershell
node scripts/devenv.mjs pnpm exec tsx --no-cache packages/collide/scripts/write-overrides.ts
node scripts/devenv.mjs pnpm exec prettier --write library/colliders
```

来源：LDraw.org 官方 3001.dat、s/3001s01.dat、3020.dat、85861.dat、stud.dat、stud2a.dat、stud4.dat；原作者包括 James Jessiman、Magnus Forsberg 及各文件 Author / !HISTORY 列出的贡献者。各文件声明 CC BY 4.0。本项目将曲面改为内接基本体并加接触内缩，原始库未修改。完整许可链接与派生数据说明见 `docs/third-party.md` 的 M3-2 追加记录。

M3-1b新增来源：上表对应的16份官方DAT及各文件notes列出的子件/图元。作者与历史贡献者署名保留在 `library/ldraw` 原始DAT的Author / !HISTORY，许可按各DAT的 !LICENSE（CC BY 4.0或同时声明CC BY 2.0/4.0）；本项目只派生盒/圆柱尺寸，未修改零件库。
