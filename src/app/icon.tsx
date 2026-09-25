import { ImageResponse } from 'next/og';

// Image metadata
export const size = {
  width: 128,
  height: 128,
};
export const contentType = 'image/png';

export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'linear-gradient(to bottom right, #3b82f6, #4f46e5)',
          borderRadius: '32px',
          color: 'white',
          fontSize: '70px',
          fontWeight: '900',
          fontFamily: 'system-ui, sans-serif'
        }}
      >
        ر
      </div>
    ),
    {
      ...size,
    }
  );
}
