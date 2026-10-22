# 宏内容（M7-1a）

`builtin/` 包含六个 `.brklmacro` 和索引；`patterns.json` 是可维护的印刷件分组规则。两者都进入 git。所有内置拼法由本项目代码描述，不包含外部模型或缩略图。

## 内置宏

尺寸为 LDU，按 X × 高度 × Z；20 LDU = 1 格，24 LDU = 1 砖。只使用 `library/packs/demo` 内的零件、颜色和可产配色。

| 名称 | ID                  | 分类          | 零件数 | 尺寸           |
| ---- | ------------------- | ------------- | -----: | -------------- |
| 桌子 | builtin.table       | furniture     |     15 | 120 × 64 × 80  |
| 椅子 | builtin.chair       | furniture     |      7 | 60 × 96 × 40   |
| 床   | builtin.bed         | furniture     |     16 | 160 × 88 × 80  |
| 书架 | builtin.bookshelf   | furniture     |     20 | 120 × 128 × 40 |
| 门   | builtin.door        | doors-windows |     23 | 120 × 184 × 40 |
| 路灯 | builtin.streetlight | other         |     13 | 80 × 192 × 80  |

椅子座高 48 LDU，桌面高 64 LDU，床面高 40 LDU。门是由普通砖搭成的固定门板与门框，不含可动铰链。路灯使用方砖灯柱，透明黄色灯体。为对齐奇偶长度零件的凸点，部分零件使用 10 LDU 水平半格位置；竖直均按 8 LDU 板高，宏原点按 20/8/20 对齐。

`scripts/build-macros.mjs` 固定描述、创建时间和 ULID 生成器；ZIP 时间固定。重建前需有只读 LDraw 库用于测量包围盒。`--check` 在内存中生成两次，比较重复生成及已入库文件的字节，不写文件。

```powershell
node scripts/devenv.mjs pnpm macros:build
node scripts/devenv.mjs pnpm macros:build --check
```

`packages/io/test/macro-builtin.test.ts` 检查六个包及索引、示例包可用性、网格、实际连接图和碰撞代理。每个宏须为一个连接分量、接地、0 穿模且无 unknown；使用库里既有连接数据，未将推断状态伪装为 reviewed。物理校验与重建检查在缺少 LDraw 时跳过，宏读回与索引校验仍运行。

## 印刷件分组统计

LDraw 配置版本 `2026-05-29`，索引版本 `2026-05-29-a3da9771cf3da882`，规则 revision 1。符合 `printed` 且有 `baseOf` 的零件共 **5,424** 件；每件最多归入一组。

| 分组         |  件数 |
| ------------ | ----: |
| 人仔表情     |   308 |
| 衣服（躯干） |   907 |
| 衣服（腿）   |   454 |
| 屏幕与显示   |    27 |
| 报纸与文字   |    22 |
| 键盘与按钮   |    16 |
| 标志与其他   |   290 |
| 未归类       | 3,400 |

当前完整库中符合标题家族的 Minifig/Friends 头部、躯干、腿/髋/裙均有分组。未归类仍包括盾牌、头盔、头发、车轮、大人仔整体与其他装饰图案，例如：

- `ld:10049p01`：白色手印图案盾牌。
- `ld:10051p01`：带手印的 Uruk-Hai 头盔。
- `ld:10055p01`：带精灵耳的辫发。
- `ld:100942p01`：六辐银色轮毂图案。
- `ld:10128p01`：绿巨人大人仔身体图案。

这些数值针对现有 catalog 的印刷件识别范围，未改变 `printed/baseOf` 的索引算法。新增基础件家族时更新规则白名单和 revision，再运行 `node scripts/devenv.mjs pnpm patterns:stats`。查询接口、优先级和分组 i18n 键详见 [catalog README](../../packages/catalog/README.md)，宏保存/插入接口见 [io README](../../packages/io/README.md)。
