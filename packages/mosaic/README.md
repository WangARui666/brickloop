# @brickloop/mosaic

M6-1a 的纯算法平面马赛克。包不访问文件系统、网络、DOM 或真实编辑器；可放入宿主 Worker。输入由宿主提供，输出是像素预览、确定性布局和可直接提交给 core 的子模型操作。

## 接入顺序

1. decodeImage(bytes) 接收 PNG/JPEG 的 Uint8Array，返回 RgbaImage（width、height、8 位 RGBA data）。也可直接提供 RGBA，省去解码。
2. generateMosaic(image, options) 接收目标格数、色板和当前数据包支持的平滑板，返回 cells、pieces、preview。
3. mosaicToOps(result, insertion) 生成完整子模型、主模型中的引用实例和 ops。宿主使用 DocumentSession.applyExternal(ops, label, 'import') 一次提交，即可一次撤销。不要逐个提交零件。

```ts
import { decodeImage, generateMosaic, mosaicToOps } from '@brickloop/mosaic';

const mosaic = generateMosaic(decodeImage(bytes), {
  width: 32,
  height: 32,
  palette: factoryColors, // { id, rgb: [r, g, b] }[]
  tiles: factoryTiles,
  style: 'square',
  dither: false,
  merge: true,
});
const insertion = mosaicToOps(mosaic, {
  name: mosaicName,
  parentModelId,
  parentStepId,
});
const committed = session.applyExternal(insertion.ops, mosaicName, 'import');
// 检查 committed.ok；由宿主通过 i18n 展示失败原因。
```

## 参数与数据包约束

- RgbaImage：正整数尺寸，RGBA 缓冲区长度必须准确。单张图和输出最大 16,777,216 像素。PNG 在解压前检查 IHDR 尺寸；JPEG 同时限制解码内存为 256 MiB。
- PaletteColor：id 为数据包 ColorId；rgb 为 sRGB 的 0–255 数值。色板不能为空，ID 不重复。算法只返回传入的颜色，不内置 Studio 或其他产品色表。
- Tile：partId、width、height、colorIds，另有可选 rotatable（默认 true）、style（默认 square；圆形用 round）。尺寸是零件在默认 LDraw 姿态下沿 X/Z 的占格数；零件局部原点应在平面中心。每种候选颜色必须有对应样式的 1×1 后备件。
- 数据包的工厂件、可用颜色组合与平滑板分类由宿主查询并过滤。不能把所有颜色盲目填入每个零件的 colorIds。常见例子：ld:3070b 为 1×1 平滑板、ld:3069b 为 1×2、ld:3068b 为 2×2、ld:98138 为 1×1 圆形平滑板；尺寸朝向以实际数据包为准。
- width/height 是输出格数。保持比例由对话框计算：编辑宽度后用源图比例计算高度，反之亦然。算法按给定尺寸缩放。
- background 默认白色，先合成透明像素，再按像素面积覆盖进行 sRGB 平均。输出预览是不透明的每格一个像素 RGBA。
- dither 默认 false；启用时从上到下、从左到右执行 Floyd–Steinberg（7/16、3/16、5/16、1/16），不蛇形扫描。
- merge 默认 false。round 永不合并，且只选 round 的 1×1 件；square 只选 square。

## 确定性和坐标

CIEDE2000 使用 D65 sRGB→Lab 和标准单位权重，数值回归覆盖公开 Sharma 测试样本。颜色候选按 ID 的码点顺序排序，同距离选第一个。相同输入、候选集合、参数与版本得到相同 cells、pieces、preview，与候选数组顺序无关。

合并从左上角逐格扫描。每格选择能够覆盖同色未占用区域且支持该颜色的最大平滑板；同面积依次优先较宽、较高、较小 PartId、未旋转。只使用传入的实际尺寸和允许的 90° 朝向，不虚构任意矩形零件。贪心算法保证无空洞、无重复覆盖，不保证全局最少件数。

图像列沿 +X、行沿 +Z，首格中心为 (0, 0, 0)，一格 20 LDU，平滑板顶面位于 Y=0。大件中心移动到覆盖矩形中心，90° 转向使用合法 LDraw 旋转矩阵；插入整体可传 transform。没有自动底板，宿主若要求实物整体连通应另外搭建底板。

mosaicToOps 默认用 core.ulid 生成实例 ID，避免多次插入冲突。需要比较完整 ops 时，传入相同初始状态的确定性 id 生成器；布局本身始终确定。parentModelId/parentStepId 必须存在，id 必须生成未使用的合法 ID，由 core 在提交时检查文档不变式。

## 解码与纯色彩接口

PNG 支持灰度、灰度透明、RGB/RGBA、索引色、低位深和 16 位采样，校验 CRC；使用 fast-png 的交错支持。JPEG 使用 jpeg-js。只解码图像像素，不应用 EXIF 自动旋转或 ICC 色彩管理，按 sRGB 解释；宿主需要时应先统一方向和色彩空间。

根入口导出 decodeImage、resizeImage、generateMosaic、mergeTiles、mosaicToOps、checkImage、checkDimensions 及相关类型。轻量入口 @brickloop/mosaic/color 导出 rgbToLab、deltaE2000、RGB、Lab，供 AI 图像对比复用。所有异常都是接口/数据错误，由界面转为 i18n 文案，不能直接把英文异常呈现给用户。

## 验证

    node scripts/devenv.mjs pnpm --filter @brickloop/mosaic test

MOS-01 使用自生成的 32×32 RGBA 图验证候选颜色约束、两次结果一致、候选乱序一致、抖动开关和合并覆盖；另外验证 PNG/JPEG、透明图、标准色差数值、圆板选择，以及插入 core.DocumentSession 后文档有效、整轮一次撤销。测试不读真实工厂库或调用网络，数据包过滤由界面适配层负责。
