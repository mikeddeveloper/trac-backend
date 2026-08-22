import { detectSafeImage, extensionForImage } from './image-signature';

describe('image signature validation', () => {
  it('accepts supported image signatures', () => {
    expect(detectSafeImage(Buffer.from([0xff, 0xd8, 0xff, 0x00]))).toBe('image/jpeg');
    expect(detectSafeImage(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('image/png');
    expect(detectSafeImage(Buffer.from('RIFF0000WEBP'))).toBe('image/webp');
  });

  it('rejects scripts renamed as images', () => {
    expect(detectSafeImage(Buffer.from('<script>alert(1)</script>'))).toBeNull();
  });

  it('uses server-controlled extensions', () => {
    expect(extensionForImage('image/jpeg')).toBe('.jpg');
    expect(extensionForImage('image/png')).toBe('.png');
    expect(extensionForImage('image/webp')).toBe('.webp');
  });
});
