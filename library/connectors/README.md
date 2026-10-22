# 示例包连接器数据

由 `pnpm connect:infer --pack demo` 生成。仅使用 LDraw 文本几何和本项目规则；未使用 Studio 连接文件、代码或数据。

数据包：222 件；已生成：222 件；包外验收编号：9 件。
状态（包内）：inferred 176，draft 46，reviewed 0。

M3-1b 补齐后：包内无连接器零件 **0**（原34）；draft **6→46**，inferred **216→176**。另保存包外3853窗框草稿，与3854窗片配对。逐件展开坐标、配对端、推断规则和局限见 [M3-1b 标注记录](M3-1b.md)。本次运行 `connect:infer`：written=181，preserved=50，failed=0；任务开始前已有10份draft文件逐字节保留。

推断不等于几何连接完整性；inferred 文件可能只有部分连接。未识别零件保留显式空数组与 inferred 状态，加载错误则中止该文件并使脚本失败。draft 是人工几何标注，仍待维护者审核。

网格数量按有效单元计。底部 tube 同时有 `cells.tube` 语义标记与实际半格位置的独立 `antistud.tube`，本表只计算实际连接项，不重复计算元数据。

## 包内类型分布

| 类型          | 单元 / 线段数量 |
| ------------- | --------------: |
| antistud      |             793 |
| antistud.tube |             438 |
| axle          |              15 |
| axle.hole     |              11 |
| ball          |               2 |
| ball.socket   |               2 |
| bar           |               7 |
| bar.hole      |               1 |
| bar.post      |             179 |
| clip          |               7 |
| fixed         |              33 |
| pin           |              11 |
| pin.hole      |             174 |
| stud          |             821 |
| stud.hollow   |             145 |
| wheel.hole    |               3 |

## 人工补写（包括验收别名）

ld:11090、ld:11477、ld:14418、ld:15712、ld:2412、ld:2412b、ld:24246、ld:25269、ld:2654a、ld:28192、ld:30027b、ld:30648、ld:32072、ld:32123a、ld:32556a、ld:3626、ld:3626c、ld:3648b、ld:3650c、ld:3700、ld:3815b、ld:3816c、ld:3817c、ld:3818、ld:3819、ld:3820、ld:3854、ld:3937、ld:3938、ld:4095、ld:44309、ld:4624、ld:48729b、ld:50950、ld:54200、ld:55982、ld:56145、ld:56898、ld:6014a、ld:60208、ld:60592、ld:60593、ld:60594、ld:60601、ld:60602、ld:63965a、ld:86210、ld:970、ld:973、ld:98138

补写依据与局限见 packages/connect/README.md；已有 draft/reviewed 文件不会被脚本覆盖。

## 自动推断未识别清单

ld:11477、ld:2412、ld:2412b、ld:24246、ld:25269、ld:28192、ld:30648、ld:3648b、ld:3815b、ld:3816c、ld:3817c、ld:3818、ld:3819、ld:3820、ld:3854、ld:3937、ld:44309、ld:4624、ld:48729b、ld:50950、ld:54200、ld:56898、ld:6014a、ld:60601、ld:60602、ld:86210、ld:970、ld:973

最终仍为空：无。

## 每件结果

| PartId    | 包内 | 类别 / 标题前缀  | 状态     | 已保存类型分布                                           | 原始推断类型分布                                  |
| --------- | ---- | ---------------- | -------- | -------------------------------------------------------- | ------------------------------------------------- |
| ld:11090  | 是   | Bar Tube         | draft    | bar.hole: 1, clip: 1                                     | clip: 1                                           |
| ld:11211  | 是   | Brick 1          | inferred | bar.post: 1, stud: 2, stud.hollow: 2                     | bar.post: 1, stud: 2, stud.hollow: 2              |
| ld:11213  | 是   | Plate 6          | inferred | antistud.tube: 12, stud: 24                              | antistud.tube: 12, stud: 24                       |
| ld:11458  | 是   | Plate 1          | inferred | antistud: 2, bar.post: 1, pin.hole: 2, stud: 1           | antistud: 2, bar.post: 1, pin.hole: 2, stud: 1    |
| ld:11477  | 是   | Slope Brick      | draft    | antistud: 2                                              | 无                                                |
| ld:14417  | 是   | Plate 1          | inferred | antistud: 2, ball: 1, bar.post: 1, stud.hollow: 2        | antistud: 2, ball: 1, bar.post: 1, stud.hollow: 2 |
| ld:14418  | 是   | Plate 1          | draft    | antistud: 2, ball.socket: 1, bar.post: 1, stud.hollow: 2 | ball.socket: 1, bar.post: 1, stud.hollow: 2       |
| ld:14419  | 是   | Plate 1          | inferred | ball.socket: 1, bar.post: 1, stud.hollow: 2              | ball.socket: 1, bar.post: 1, stud.hollow: 2       |
| ld:14719  | 是   | Tile 2           | inferred | antistud: 3, bar.post: 2                                 | antistud: 3, bar.post: 2                          |
| ld:14769  | 是   | Tile 2           | inferred | antistud.tube: 1                                         | antistud.tube: 1                                  |
| ld:15068  | 是   | Slope Brick      | inferred | bar.post: 2                                              | bar.post: 2                                       |
| ld:15573  | 是   | Plate 1          | inferred | stud.hollow: 1                                           | stud.hollow: 1                                    |
| ld:15712  | 验收 | Tile 1           | draft    | antistud: 1, clip: 1                                     | antistud: 1                                       |
| ld:18674  | 是   | Plate 2          | inferred | antistud.tube: 1, stud.hollow: 1                         | antistud.tube: 1, stud.hollow: 1                  |
| ld:22885  | 是   | Brick 1          | inferred | stud: 2, stud.hollow: 4                                  | stud: 2, stud.hollow: 4                           |
| ld:22890  | 是   | Plate 1          | inferred | antistud: 2, ball: 1, bar.post: 1, stud.hollow: 2        | antistud: 2, ball: 1, bar.post: 1, stud.hollow: 2 |
| ld:2357   | 是   | Brick 2          | inferred | antistud: 3, bar.post: 2, stud: 3                        | antistud: 3, bar.post: 2, stud: 3                 |
| ld:2412   | 验收 | ~Moved to        | draft    | antistud: 2                                              | 无                                                |
| ld:2412b  | 是   | Tile 1           | draft    | antistud: 2                                              | 无                                                |
| ld:2417   | 是   | Plant Leaves     | inferred | antistud.tube: 6, stud.hollow: 14                        | antistud.tube: 6, stud.hollow: 14                 |
| ld:2420   | 是   | Plate 2          | inferred | antistud: 3, bar.post: 2, stud: 3                        | antistud: 3, bar.post: 2, stud: 3                 |
| ld:2423   | 是   | Plant Leaves     | inferred | antistud.tube: 1, stud.hollow: 6                         | antistud.tube: 1, stud.hollow: 6                  |
| ld:24246  | 是   | Tile 1           | draft    | antistud: 1                                              | 无                                                |
| ld:24309  | 是   | Slope Brick      | inferred | antistud.tube: 1, bar.post: 1                            | antistud.tube: 1, bar.post: 1                     |
| ld:2431   | 是   | Tile 1           | inferred | antistud: 4, bar.post: 3                                 | antistud: 4, bar.post: 3                          |
| ld:2445   | 是   | Plate 2          | inferred | antistud: 24, antistud.tube: 11, stud: 24                | antistud: 24, antistud.tube: 11, stud: 24         |
| ld:2453a  | 是   | Brick 1          | inferred | stud.hollow: 1                                           | stud.hollow: 1                                    |
| ld:2454a  | 是   | Brick 1          | inferred | stud.hollow: 2                                           | stud.hollow: 2                                    |
| ld:2456   | 是   | Brick 2          | inferred | antistud: 12, antistud.tube: 5, stud: 12                 | antistud: 12, antistud.tube: 5, stud: 12          |
| ld:2465   | 是   | Brick 1          | inferred | antistud: 16, bar.post: 15, stud: 16                     | antistud: 16, bar.post: 15, stud: 16              |
| ld:24866  | 是   | Plate 1          | inferred | antistud.tube: 1, stud.hollow: 1                         | antistud.tube: 1, stud.hollow: 1                  |
| ld:25269  | 是   | Tile 1           | draft    | antistud: 1                                              | 无                                                |
| ld:2540   | 是   | Plate 1          | inferred | antistud: 2, bar.post: 1, stud: 2                        | antistud: 2, bar.post: 1, stud: 2                 |
| ld:2654a  | 是   | Dish 2           | draft    | stud.hollow: 4                                           | stud.hollow: 4                                    |
| ld:26603  | 是   | Tile 2           | inferred | antistud: 6, antistud.tube: 2                            | antistud: 6, antistud.tube: 2                     |
| ld:2780   | 是   | Technic Pin      | inferred | pin: 2                                                   | pin: 2                                            |
| ld:28192  | 是   | Slope Brick      | draft    | antistud: 2                                              | 无                                                |
| ld:2877   | 是   | Brick 1          | inferred | antistud: 2, bar.post: 1, stud: 2                        | antistud: 2, bar.post: 1, stud: 2                 |
| ld:3001   | 是   | Brick 2          | inferred | antistud: 8, antistud.tube: 3, stud: 8                   | antistud: 8, antistud.tube: 3, stud: 8            |
| ld:3002   | 是   | Brick 2          | inferred | antistud: 6, antistud.tube: 2, stud: 6                   | antistud: 6, antistud.tube: 2, stud: 6            |
| ld:30027b | 是   | Wheel Rim        | draft    | fixed: 1, wheel.hole: 1                                  | wheel.hole: 1                                     |
| ld:3003   | 是   | Brick 2          | inferred | antistud: 4, antistud.tube: 1, stud: 4                   | antistud: 4, antistud.tube: 1, stud: 4            |
| ld:3004   | 是   | Brick 1          | inferred | antistud: 2, bar.post: 1, stud: 2                        | antistud: 2, bar.post: 1, stud: 2                 |
| ld:3005   | 是   | Brick 1          | inferred | antistud: 1, stud: 1                                     | antistud: 1, stud: 1                              |
| ld:3006   | 是   | Brick 2          | inferred | antistud: 20, antistud.tube: 9, stud: 20                 | antistud: 20, antistud.tube: 9, stud: 20          |
| ld:3007   | 是   | Brick 2          | inferred | antistud: 16, antistud.tube: 7, stud: 16                 | antistud: 16, antistud.tube: 7, stud: 16          |
| ld:3008   | 是   | Brick 1          | inferred | antistud: 8, bar.post: 7, stud: 8                        | antistud: 8, bar.post: 7, stud: 8                 |
| ld:3009   | 是   | Brick 1          | inferred | antistud: 6, bar.post: 5, stud: 6                        | antistud: 6, bar.post: 5, stud: 6                 |
| ld:3010   | 是   | Brick 1          | inferred | antistud: 4, bar.post: 3, stud: 4                        | antistud: 4, bar.post: 3, stud: 4                 |
| ld:30144  | 是   | Brick 2          | inferred | antistud: 8, antistud.tube: 3, stud: 8                   | antistud: 8, antistud.tube: 3, stud: 8            |
| ld:30176  | 是   | Plant Brick      | inferred | antistud.tube: 1, stud.hollow: 1                         | antistud.tube: 1, stud.hollow: 1                  |
| ld:3020   | 是   | Plate 2          | inferred | antistud: 8, antistud.tube: 3, stud: 8                   | antistud: 8, antistud.tube: 3, stud: 8            |
| ld:3021   | 是   | Plate 2          | inferred | antistud: 6, antistud.tube: 2, stud: 6                   | antistud: 6, antistud.tube: 2, stud: 6            |
| ld:3022   | 是   | Plate 2          | inferred | antistud: 4, antistud.tube: 1, stud: 4                   | antistud: 4, antistud.tube: 1, stud: 4            |
| ld:3023   | 验收 | ~Moved to        | inferred | antistud: 2, bar.post: 1, stud: 2                        | antistud: 2, bar.post: 1, stud: 2                 |
| ld:3023b  | 是   | Plate 1          | inferred | antistud: 2, bar.post: 1, stud: 2                        | antistud: 2, bar.post: 1, stud: 2                 |
| ld:3024   | 是   | Plate 1          | inferred | antistud: 1, stud: 1                                     | antistud: 1, stud: 1                              |
| ld:3028   | 是   | Plate 6          | inferred | antistud: 72, antistud.tube: 55, stud: 72                | antistud: 72, antistud.tube: 55, stud: 72         |
| ld:3029   | 是   | Plate 4          | inferred | antistud: 48, antistud.tube: 33, stud: 48                | antistud: 48, antistud.tube: 33, stud: 48         |
| ld:3030   | 是   | Plate 4          | inferred | antistud: 40, antistud.tube: 27, stud: 40                | antistud: 40, antistud.tube: 27, stud: 40         |
| ld:3031   | 是   | Plate 4          | inferred | antistud: 16, antistud.tube: 9, stud: 16                 | antistud: 16, antistud.tube: 9, stud: 16          |
| ld:3032   | 是   | Plate 4          | inferred | antistud: 24, antistud.tube: 15, stud: 24                | antistud: 24, antistud.tube: 15, stud: 24         |
| ld:3033   | 是   | Plate 6          | inferred | antistud: 60, antistud.tube: 45, stud: 60                | antistud: 60, antistud.tube: 45, stud: 60         |
| ld:3034   | 是   | Plate 2          | inferred | antistud: 16, antistud.tube: 7, stud: 16                 | antistud: 16, antistud.tube: 7, stud: 16          |
| ld:3035   | 是   | Plate 4          | inferred | antistud: 32, antistud.tube: 21, stud: 32                | antistud: 32, antistud.tube: 21, stud: 32         |
| ld:3036   | 是   | Plate 6          | inferred | antistud: 48, antistud.tube: 35, stud: 48                | antistud: 48, antistud.tube: 35, stud: 48         |
| ld:30363  | 是   | Slope Brick      | inferred | antistud.tube: 3, stud: 2                                | antistud.tube: 3, stud: 2                         |
| ld:3037   | 是   | Slope Brick      | inferred | antistud.tube: 3, stud: 4                                | antistud.tube: 3, stud: 4                         |
| ld:30374  | 是   | Bar 4L           | inferred | bar: 1                                                   | bar: 1                                            |
| ld:3038   | 是   | Slope Brick      | inferred | antistud.tube: 2, stud: 3                                | antistud.tube: 2, stud: 3                         |
| ld:30383  | 是   | Hinge Plate      | inferred | bar.post: 1, stud: 1                                     | bar.post: 1, stud: 1                              |
| ld:3039   | 是   | Slope Brick      | inferred | antistud.tube: 1, stud: 2                                | antistud.tube: 1, stud: 2                         |
| ld:30395  | 是   | Hook with        | inferred | stud.hollow: 2                                           | stud.hollow: 2                                    |
| ld:3040b  | 是   | Slope Brick      | inferred | bar.post: 1, stud: 1                                     | bar.post: 1, stud: 1                              |
| ld:3041   | 是   | Slope Brick      | inferred | antistud.tube: 3                                         | antistud.tube: 3                                  |
| ld:3042   | 是   | Slope Brick      | inferred | antistud.tube: 2                                         | antistud.tube: 2                                  |
| ld:3045   | 是   | Slope Brick      | inferred | antistud.tube: 1, stud: 1                                | antistud.tube: 1, stud: 1                         |
| ld:3046   | 是   | Slope Brick      | inferred | antistud.tube: 1, stud: 3                                | antistud.tube: 1, stud: 3                         |
| ld:3062b  | 是   | Brick 1          | inferred | antistud.tube: 1, stud.hollow: 1                         | antistud.tube: 1, stud.hollow: 1                  |
| ld:30648  | 是   | Tyre 14/         | draft    | fixed: 1                                                 | 无                                                |
| ld:3068b  | 是   | Tile 2           | inferred | antistud: 4, antistud.tube: 1                            | antistud: 4, antistud.tube: 1                     |
| ld:3069b  | 是   | Tile 1           | inferred | antistud: 2                                              | antistud: 2                                       |
| ld:3070b  | 是   | Tile 1           | inferred | antistud: 1                                              | antistud: 1                                       |
| ld:32000  | 是   | Technic Brick    | inferred | pin.hole: 4, stud.hollow: 2                              | pin.hole: 4, stud.hollow: 2                       |
| ld:32062  | 是   | Technic Axle     | inferred | axle: 3                                                  | axle: 3                                           |
| ld:32072  | 是   | Technic Gear     | draft    | axle.hole: 1                                             | axle.hole: 1                                      |
| ld:32073  | 是   | Technic Axle     | inferred | axle: 1                                                  | axle: 1                                           |
| ld:32123a | 是   | Technic Bush     | draft    | axle.hole: 1                                             | axle.hole: 1                                      |
| ld:32278  | 是   | Technic Beam     | inferred | pin.hole: 30                                             | pin.hole: 30                                      |
| ld:32316  | 是   | Technic Beam     | inferred | pin.hole: 10                                             | pin.hole: 10                                      |
| ld:32523  | 验收 | Technic Beam     | inferred | pin.hole: 6                                              | pin.hole: 6                                       |
| ld:32524  | 是   | Technic Beam     | inferred | pin.hole: 14                                             | pin.hole: 14                                      |
| ld:32525  | 是   | Technic Beam     | inferred | pin.hole: 22                                             | pin.hole: 22                                      |
| ld:32556a | 是   | Technic Pin      | draft    | pin: 2                                                   | pin: 2                                            |
| ld:32607  | 是   | Plate 1          | inferred | antistud.tube: 1, stud.hollow: 1                         | antistud.tube: 1, stud.hollow: 1                  |
| ld:3297   | 是   | Slope Brick      | inferred | antistud.tube: 6, stud: 4                                | antistud.tube: 6, stud: 4                         |
| ld:3298   | 是   | Slope Brick      | inferred | antistud.tube: 2, stud: 2                                | antistud.tube: 2, stud: 2                         |
| ld:3299   | 是   | Slope Brick      | inferred | antistud.tube: 3                                         | antistud.tube: 3                                  |
| ld:33291  | 是   | Plate 1          | inferred | antistud.tube: 1, stud.hollow: 1                         | antistud.tube: 1, stud.hollow: 1                  |
| ld:3460   | 是   | Plate 1          | inferred | antistud: 8, bar.post: 7, stud: 8                        | antistud: 8, bar.post: 7, stud: 8                 |
| ld:3622   | 是   | Brick 1          | inferred | antistud: 3, bar.post: 2, stud: 3                        | antistud: 3, bar.post: 2, stud: 3                 |
| ld:3623   | 是   | Plate 1          | inferred | antistud: 3, bar.post: 2, stud: 3                        | antistud: 3, bar.post: 2, stud: 3                 |
| ld:3626   | 验收 | ~Moved to        | draft    | fixed: 1, stud.hollow: 1                                 | stud.hollow: 1                                    |
| ld:3626c  | 是   | Minifig Head     | draft    | fixed: 1, stud.hollow: 1                                 | stud.hollow: 1                                    |
| ld:3647   | 是   | Technic Gear     | inferred | axle.hole: 1                                             | axle.hole: 1                                      |
| ld:3648b  | 是   | Technic Gear     | draft    | axle.hole: 1, pin.hole: 4                                | 无                                                |
| ld:3650c  | 是   | Technic Gear     | draft    | axle.hole: 1                                             | axle.hole: 1                                      |
| ld:3660b  | 是   | Slope Brick      | inferred | stud: 2, stud.hollow: 2                                  | stud: 2, stud.hollow: 2                           |
| ld:3665a  | 是   | Slope Brick      | inferred | stud: 1, stud.hollow: 1                                  | stud: 1, stud.hollow: 1                           |
| ld:3666   | 是   | Plate 1          | inferred | antistud: 6, bar.post: 5, stud: 6                        | antistud: 6, bar.post: 5, stud: 6                 |
| ld:3673   | 是   | Technic Pin      | inferred | pin: 2                                                   | pin: 2                                            |
| ld:3678a  | 是   | Slope Brick      | inferred | stud: 2                                                  | stud: 2                                           |
| ld:3700   | 是   | Technic Brick    | draft    | antistud: 2, bar.post: 1, pin.hole: 2, stud.hollow: 2    | bar.post: 1, pin.hole: 2, stud.hollow: 2          |
| ld:3701   | 是   | Technic Brick    | inferred | bar.post: 3, pin.hole: 6, stud.hollow: 4                 | bar.post: 3, pin.hole: 6, stud.hollow: 4          |
| ld:3702   | 是   | Technic Brick    | inferred | bar.post: 7, pin.hole: 14, stud.hollow: 8                | bar.post: 7, pin.hole: 14, stud.hollow: 8         |
| ld:3705   | 是   | Technic Axle     | inferred | axle: 1                                                  | axle: 1                                           |
| ld:3706   | 是   | Technic Axle     | inferred | axle: 1                                                  | axle: 1                                           |
| ld:3707   | 是   | Technic Axle     | inferred | axle: 1                                                  | axle: 1                                           |
| ld:3708   | 是   | Technic Axle     | inferred | axle: 1                                                  | axle: 1                                           |
| ld:3710   | 是   | Plate 1          | inferred | antistud: 4, bar.post: 3, stud: 4                        | antistud: 4, bar.post: 3, stud: 4                 |
| ld:3713   | 是   | Technic Bush     | inferred | axle.hole: 1                                             | axle.hole: 1                                      |
| ld:3737   | 是   | Technic Axle     | inferred | axle: 1                                                  | axle: 1                                           |
| ld:3741a  | 是   | Plant Flower     | inferred | stud: 1                                                  | stud: 1                                           |
| ld:3747b  | 是   | Slope Brick      | inferred | stud: 2, stud.hollow: 4                                  | stud: 2, stud.hollow: 4                           |
| ld:3749   | 是   | Technic Axle     | inferred | axle: 1, pin: 1                                          | axle: 1, pin: 1                                   |
| ld:3755a  | 是   | Brick 1          | inferred | stud.hollow: 3                                           | stud.hollow: 3                                    |
| ld:3794   | 验收 | ~Moved to        | inferred | antistud: 2, bar.post: 1, stud.hollow: 1                 | antistud: 2, bar.post: 1, stud.hollow: 1          |
| ld:3795   | 是   | Plate 2          | inferred | antistud: 12, antistud.tube: 5, stud: 12                 | antistud: 12, antistud.tube: 5, stud: 12          |
| ld:3815b  | 是   | Minifig Hips     | draft    | fixed: 3                                                 | 无                                                |
| ld:3816c  | 是   | Minifig Leg      | draft    | antistud: 2, fixed: 1                                    | 无                                                |
| ld:3817c  | 是   | Minifig Leg      | draft    | antistud: 2, fixed: 1                                    | 无                                                |
| ld:3818   | 是   | Minifig Arm      | draft    | fixed: 2                                                 | 无                                                |
| ld:3819   | 是   | Minifig Arm      | draft    | fixed: 2                                                 | 无                                                |
| ld:3820   | 是   | Minifig Hand     | draft    | clip: 1, fixed: 1                                        | 无                                                |
| ld:3832   | 是   | Plate 2          | inferred | antistud: 20, antistud.tube: 9, stud: 20                 | antistud: 20, antistud.tube: 9, stud: 20          |
| ld:3854   | 是   | Window 1         | draft    | fixed: 1                                                 | 无                                                |
| ld:3894   | 是   | Technic Brick    | inferred | bar.post: 5, pin.hole: 10, stud.hollow: 6                | bar.post: 5, pin.hole: 10, stud.hollow: 6         |
| ld:3895   | 是   | Technic Brick    | inferred | bar.post: 11, pin.hole: 22, stud.hollow: 12              | bar.post: 11, pin.hole: 22, stud.hollow: 12       |
| ld:3937   | 是   | Hinge 1          | draft    | antistud: 2, fixed: 1                                    | 无                                                |
| ld:3938   | 是   | Hinge 1          | draft    | fixed: 1, stud.hollow: 2                                 | stud.hollow: 2                                    |
| ld:3941   | 是   | Brick 2          | inferred | antistud.tube: 1, axle.hole: 1                           | antistud.tube: 1, axle.hole: 1                    |
| ld:3942c  | 是   | Cone 2           | inferred | antistud.tube: 1, stud.hollow: 1                         | antistud.tube: 1, stud.hollow: 1                  |
| ld:3957b  | 是   | Antenna 4H       | inferred | antistud.tube: 1                                         | antistud.tube: 1                                  |
| ld:3958   | 是   | Plate 6          | inferred | antistud: 36, antistud.tube: 25, stud: 36                | antistud: 36, antistud.tube: 25, stud: 36         |
| ld:3960   | 是   | Dish 4           | inferred | antistud.tube: 1, axle.hole: 1, stud: 1                  | antistud.tube: 1, axle.hole: 1, stud: 1           |
| ld:3961   | 是   | Dish 8           | inferred | antistud.tube: 1, stud: 4                                | antistud.tube: 1, stud: 4                         |
| ld:4032a  | 是   | Plate 2          | inferred | antistud.tube: 1                                         | antistud.tube: 1                                  |
| ld:4035   | 是   | Train Window     | inferred | stud.hollow: 2                                           | stud.hollow: 2                                    |
| ld:40490  | 是   | Technic Beam     | inferred | pin.hole: 18                                             | pin.hole: 18                                      |
| ld:4070   | 是   | Brick 1          | inferred | stud: 1, stud.hollow: 1                                  | stud: 1, stud.hollow: 1                           |
| ld:4073   | 验收 | ~Moved to        | inferred | antistud.tube: 1, stud: 1                                | antistud.tube: 1, stud: 1                         |
| ld:4081b  | 是   | Plate 1          | inferred | antistud: 1, stud: 1, stud.hollow: 2                     | antistud: 1, stud: 1, stud.hollow: 2              |
| ld:4085   | 验收 | ~Moved to        | inferred | antistud: 1, clip: 1, stud: 1                            | antistud: 1, clip: 1, stud: 1                     |
| ld:4085c  | 是   | Plate 1          | inferred | antistud: 1, clip: 1, stud: 1                            | antistud: 1, clip: 1, stud: 1                     |
| ld:4095   | 是   | Bar 6.6L         | draft    | bar: 2                                                   | bar: 2                                            |
| ld:4162   | 是   | Tile 1           | inferred | antistud: 8, bar.post: 7                                 | antistud: 8, bar.post: 7                          |
| ld:41769a | 是   | Wing 2           | inferred | antistud.tube: 1, stud: 4                                | antistud.tube: 1, stud: 4                         |
| ld:41770a | 是   | Wing 2           | inferred | antistud.tube: 1, stud: 4                                | antistud.tube: 1, stud: 4                         |
| ld:4274   | 是   | Technic Pin      | inferred | pin: 1, stud.hollow: 1                                   | pin: 1, stud.hollow: 1                            |
| ld:4275b  | 是   | Hinge Plate      | inferred | bar.post: 1, stud.hollow: 2                              | bar.post: 1, stud.hollow: 2                       |
| ld:4276b  | 是   | Hinge Plate      | inferred | bar.post: 1, stud.hollow: 2                              | bar.post: 1, stud.hollow: 2                       |
| ld:4282   | 是   | Plate 2          | inferred | antistud: 32, antistud.tube: 15, stud: 32                | antistud: 32, antistud.tube: 15, stud: 32         |
| ld:43093  | 是   | Technic Axle     | inferred | axle: 1, pin: 1                                          | axle: 1, pin: 1                                   |
| ld:43722a | 是   | Wing 2           | inferred | stud: 3                                                  | stud: 3                                           |
| ld:43723a | 是   | Wing 2           | inferred | stud: 3                                                  | stud: 3                                           |
| ld:44294  | 是   | Technic Axle     | inferred | axle: 1                                                  | axle: 1                                           |
| ld:44301a | 是   | Hinge Plate      | inferred | bar.post: 1, stud: 2                                     | bar.post: 1, stud: 2                              |
| ld:44302a | 是   | Hinge Plate      | inferred | bar.post: 1, stud: 2                                     | bar.post: 1, stud: 2                              |
| ld:44309  | 是   | Tyre 22/         | draft    | fixed: 1                                                 | 无                                                |
| ld:44567a | 是   | Hinge Plate      | inferred | bar.post: 1, stud: 2                                     | bar.post: 1, stud: 2                              |
| ld:4460b  | 是   | Slope Brick      | inferred | stud.hollow: 1                                           | stud.hollow: 1                                    |
| ld:4477   | 是   | Plate 1          | inferred | antistud: 10, bar.post: 9, stud: 10                      | antistud: 10, bar.post: 9, stud: 10               |
| ld:4519   | 是   | Technic Axle     | inferred | axle: 1                                                  | axle: 1                                           |
| ld:4589   | 是   | Cone 1           | inferred | axle.hole: 1, stud.hollow: 1                             | axle.hole: 1, stud.hollow: 1                      |
| ld:4624   | 是   | Wheel Rim        | draft    | fixed: 1, wheel.hole: 1                                  | 无                                                |
| ld:4733   | 是   | Brick 1          | inferred | stud.hollow: 5                                           | stud.hollow: 5                                    |
| ld:4740   | 是   | Dish 2           | inferred | antistud.tube: 1, stud.hollow: 1                         | antistud.tube: 1, stud.hollow: 1                  |
| ld:48336  | 是   | Plate 1          | inferred | antistud: 2, bar.post: 1, stud: 2                        | antistud: 2, bar.post: 1, stud: 2                 |
| ld:48729b | 是   | Bar 1.5L         | draft    | bar: 1, clip: 1                                          | 无                                                |
| ld:50950  | 是   | Slope Brick      | draft    | antistud: 3                                              | 无                                                |
| ld:52107  | 是   | Brick 1          | inferred | bar.post: 1, stud: 2, stud.hollow: 4                     | bar.post: 1, stud: 2, stud.hollow: 4              |
| ld:54200  | 是   | Slope Brick      | draft    | antistud: 1                                              | 无                                                |
| ld:55982  | 是   | Wheel Rim        | draft    | axle.hole: 1, fixed: 1                                   | axle.hole: 1                                      |
| ld:56145  | 是   | Wheel Rim        | draft    | axle.hole: 1, fixed: 1                                   | axle.hole: 1                                      |
| ld:56898  | 是   | Tyre 14/         | draft    | fixed: 1                                                 | 无                                                |
| ld:59900  | 是   | Cone 1           | inferred | stud.hollow: 1                                           | stud.hollow: 1                                    |
| ld:6014a  | 是   | Wheel Rim        | draft    | fixed: 1, wheel.hole: 1                                  | 无                                                |
| ld:60208  | 是   | Wheel Rim        | draft    | fixed: 1, pin.hole: 14                                   | pin.hole: 14                                      |
| ld:60470b | 是   | Plate 1          | inferred | antistud: 2, bar.post: 1, clip: 2, stud: 2               | antistud: 2, bar.post: 1, clip: 2, stud: 2        |
| ld:60471  | 是   | Hinge Plate      | inferred | bar.post: 1, stud: 2                                     | bar.post: 1, stud: 2                              |
| ld:60474  | 是   | Plate 4          | inferred | antistud.tube: 4, stud: 12                               | antistud.tube: 4, stud: 12                        |
| ld:60477  | 是   | Slope Brick      | inferred | bar.post: 3, stud: 1                                     | bar.post: 3, stud: 1                              |
| ld:60478  | 是   | Plate 1          | inferred | antistud: 2, bar.post: 1, stud: 2                        | antistud: 2, bar.post: 1, stud: 2                 |
| ld:60479  | 是   | Plate 1          | inferred | antistud: 12, bar.post: 11, stud: 12                     | antistud: 12, bar.post: 11, stud: 12              |
| ld:60485  | 是   | Technic Axle     | inferred | axle: 1                                                  | axle: 1                                           |
| ld:60592  | 是   | Window 1         | draft    | fixed: 1, stud.hollow: 2                                 | stud.hollow: 2                                    |
| ld:60593  | 是   | Window 1         | draft    | fixed: 1, stud.hollow: 2                                 | stud.hollow: 2                                    |
| ld:60594  | 是   | Window 1         | draft    | bar.post: 3, fixed: 1, stud.hollow: 2                    | bar.post: 3, stud.hollow: 2                       |
| ld:60596  | 是   | Door 1           | inferred | bar.post: 3, stud.hollow: 2                              | bar.post: 3, stud.hollow: 2                       |
| ld:60601  | 是   | Glass for        | draft    | fixed: 1                                                 | 无                                                |
| ld:60602  | 是   | Glass for        | draft    | fixed: 1                                                 | 无                                                |
| ld:60616a | 是   | Door 1           | inferred | stud.hollow: 2                                           | stud.hollow: 2                                    |
| ld:6064b  | 是   | Plant Bush       | inferred | stud.hollow: 1                                           | stud.hollow: 1                                    |
| ld:6111   | 是   | Brick 1          | inferred | antistud: 10, bar.post: 9, stud: 10                      | antistud: 10, bar.post: 9, stud: 10               |
| ld:6112   | 是   | Brick 1          | inferred | antistud: 12, bar.post: 11, stud: 12                     | antistud: 12, bar.post: 11, stud: 12              |
| ld:61252  | 是   | Plate 1          | inferred | antistud: 1, clip: 1, stud: 1                            | antistud: 1, clip: 1, stud: 1                     |
| ld:6141   | 是   | Plate 1          | inferred | antistud.tube: 1, stud: 1                                | antistud.tube: 1, stud: 1                         |
| ld:6143   | 是   | Brick 2          | inferred | antistud.tube: 1                                         | antistud.tube: 1                                  |
| ld:6179   | 是   | Plate 4          | inferred | antistud: 16, antistud.tube: 9, stud: 4                  | antistud: 16, antistud.tube: 9, stud: 4           |
| ld:63864  | 是   | Tile 1           | inferred | antistud: 3, bar.post: 2                                 | antistud: 3, bar.post: 2                          |
| ld:63965a | 是   | Bar 6L           | draft    | bar: 2                                                   | bar: 2                                            |
| ld:6541   | 是   | Technic Brick    | inferred | antistud: 1, pin.hole: 2, stud.hollow: 1                 | antistud: 1, pin.hole: 2, stud.hollow: 1          |
| ld:6558   | 是   | Technic Pin      | inferred | pin: 2                                                   | pin: 2                                            |
| ld:6636   | 是   | Tile 1           | inferred | antistud: 6, bar.post: 5                                 | antistud: 6, bar.post: 5                          |
| ld:85984  | 是   | Slope Brick      | inferred | bar.post: 1                                              | bar.post: 1                                       |
| ld:86210  | 是   | Glass for        | draft    | fixed: 1                                                 | 无                                                |
| ld:87079  | 是   | Tile 2           | inferred | antistud: 8, antistud.tube: 3                            | antistud: 8, antistud.tube: 3                     |
| ld:87087  | 是   | Brick 1          | inferred | stud: 1, stud.hollow: 1                                  | stud: 1, stud.hollow: 1                           |
| ld:87580  | 是   | Plate 2          | inferred | antistud.tube: 1, stud.hollow: 1                         | antistud.tube: 1, stud.hollow: 1                  |
| ld:87994  | 是   | Bar 3L           | inferred | bar: 1                                                   | bar: 1                                            |
| ld:88930  | 是   | Slope Brick      | inferred | antistud.tube: 3                                         | antistud.tube: 3                                  |
| ld:92280  | 是   | Plate 1          | inferred | antistud: 2, bar.post: 1, stud: 1                        | antistud: 2, bar.post: 1, stud: 1                 |
| ld:92906  | 是   | Technic Steering | inferred | axle: 1                                                  | axle: 1                                           |
| ld:970    | 验收 | ~Moved to        | draft    | fixed: 3                                                 | 无                                                |
| ld:973    | 是   | Minifig Torso    | draft    | fixed: 4                                                 | 无                                                |
| ld:98138  | 是   | Tile 1           | draft    | antistud.tube: 1                                         | antistud.tube: 1                                  |
| ld:98283  | 是   | Brick 1          | inferred | antistud: 2, bar.post: 1, stud: 2                        | antistud: 2, bar.post: 1, stud: 2                 |
| ld:99206  | 是   | Plate 2          | inferred | antistud.tube: 1, stud: 4, stud.hollow: 2                | antistud.tube: 1, stud: 4, stud.hollow: 2         |
| ld:99207  | 是   | Bracket 1        | inferred | bar.post: 1, stud: 2, stud.hollow: 4                     | bar.post: 1, stud: 2, stud.hollow: 4              |
| ld:99780  | 是   | Bracket 1        | inferred | bar.post: 1, stud: 2, stud.hollow: 2                     | bar.post: 1, stud: 2, stud.hollow: 2              |
| ld:99781  | 是   | Bracket 1        | inferred | bar.post: 1, stud: 2, stud.hollow: 2                     | bar.post: 1, stud: 2, stud.hollow: 2              |

来源、作者署名与许可证：LDraw.org 官方库，逐文件 Author / !HISTORY / !LICENSE 保留在 library/ldraw 对应 DAT；派生与修改说明见 docs/third-party.md。
