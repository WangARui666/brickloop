import { Image } from 'antd';
import type { ImageBlock } from '@brickloop/ai';
import { useTranslation } from './store';

export const imageSource = (image: ImageBlock) => `data:${image.mime};base64,${image.base64}`;
export function AiImages({ images, comparison = false }: { images: ImageBlock[]; comparison?: boolean }) {
  const t = useTranslation();
  return (
    <Image.PreviewGroup>
      <div className={`ai-images ai-image-grid ${images.length > 1 ? 'multiple' : ''}`}>
        {images.map((image, index) => (
          <div key={index} className="ai-image-cell">
            <Image src={imageSource(image)} alt={t(comparison && index === 0 ? 'aiUi.reference' : 'aiUi.rendered')} />
            {comparison && <small>{t(index === 0 ? 'aiUi.reference' : 'imageUi.renderLabel')}</small>}
          </div>
        ))}
      </div>
    </Image.PreviewGroup>
  );
}

export async function readImageFiles(
  files: FileList | File[],
  limit: number,
): Promise<{ name: string; image: ImageBlock }[]> {
  if (files.length > limit) throw new Error('IMAGE_COUNT');
  return Promise.all(
    Array.from(files)
      .slice(0, limit)
      .map(async (file) => {
        if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type) || file.size > 10_000_000)
          throw new Error('IMAGE_SIZE');
        const base64 = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result).split(',')[1]!);
          reader.onerror = reject;
          reader.readAsDataURL(file);
        });
        return {
          name: file.name.slice(0, 200),
          image: { type: 'image' as const, mime: file.type as ImageBlock['mime'], base64 },
        };
      }),
  );
}
