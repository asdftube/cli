import { describe, expect, it } from 'vitest';

import { buildScreenCaptureVideoArgs } from '../src/capture';

describe('macOS screen capture arguments', () => {
  it('enables cursor and click indicators by default', () => {
    expect(
      buildScreenCaptureVideoArgs(
        {
          seconds: 1
        },
        '/tmp/capture.mov'
      )
    ).toEqual(['-v', '-x', '-V1', '-C', '-k', '/tmp/capture.mov']);
  });

  it('can disable cursor and click indicators', () => {
    expect(
      buildScreenCaptureVideoArgs(
        {
          seconds: 1,
          includeCursor: false,
          showClicks: false
        },
        '/tmp/capture.mov'
      )
    ).toEqual(['-v', '-x', '-V1', '/tmp/capture.mov']);
  });

  it('adds input audio and display or window targeting', () => {
    expect(
      buildScreenCaptureVideoArgs(
        {
          seconds: 1,
          withAudio: true,
          display: 2
        },
        '/tmp/capture.mov'
      )
    ).toEqual(['-v', '-x', '-V1', '-C', '-k', '-g', '-D2', '/tmp/capture.mov']);

    expect(
      buildScreenCaptureVideoArgs(
        {
          seconds: 1,
          audioDeviceId: 'BuiltInMicrophoneDevice'
        },
        '/tmp/capture.mov',
        184
      )
    ).toEqual(['-v', '-x', '-V1', '-C', '-k', '-GBuiltInMicrophoneDevice', '-l184', '/tmp/capture.mov']);
  });
});
