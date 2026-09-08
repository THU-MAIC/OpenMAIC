import { describe, expect, it } from 'vitest';

import {
  buildEdukuAccessTokenRequest,
  edukuSignature,
  extractEdukuUserProfile,
} from '@/lib/server/auth/eduku';
import { normalizeEdukuProfile } from '@/lib/persistence/user-accounts';

describe('edukuSignature', () => {
  it('matches the vendor contract MD5(appId + code + appSecret)', () => {
    // Precomputed with an independent MD5 implementation.
    expect(
      edukuSignature('ew56ca729808cb4927', 'TESTCODE', '49a3bb96a9ddb79a17e7f4885e3e2627'),
    ).toBe('a6142be11f4d2e47ad7cc10d5c6fcd92');
  });

  it('is sensitive to every input part', () => {
    const base = edukuSignature('app', 'code', 'secret');
    expect(edukuSignature('appx', 'code', 'secret')).not.toBe(base);
    expect(edukuSignature('app', 'codex', 'secret')).not.toBe(base);
    expect(edukuSignature('app', 'code', 'secretx')).not.toBe(base);
  });
});

describe('buildEdukuAccessTokenRequest', () => {
  it('posts the form the live gateway accepts (POST + appid + dataType=json)', () => {
    const request = buildEdukuAccessTokenRequest(
      'CODE123',
      'ew56ca729808cb4927',
      '49a3bb96a9ddb79a17e7f4885e3e2627',
    );
    expect(request.init.method).toBe('POST');
    expect(request.url).toContain('/api/v1/user/accesstoken');
    const body = new URLSearchParams(request.init.body);
    expect(body.get('code')).toBe('CODE123');
    // The doc writes appId, the live server reads appid.
    expect(body.get('appid')).toBe('ew56ca729808cb4927');
    expect(body.get('appId')).toBeNull();
    expect(body.get('signature')).toBe(
      edukuSignature('ew56ca729808cb4927', 'CODE123', '49a3bb96a9ddb79a17e7f4885e3e2627'),
    );
    expect(body.get('dataType')).toBe('json');
    expect(request.init.headers['content-type']).toContain('application/x-www-form-urlencoded');
  });
});

// The real accesstoken response captured from the live gateway (trimmed to the
// fields the login system consumes). Note: no edukuopenid/role — the
// discriminator is `usertype`.
const liveVendorData = {
  total: 1,
  success: true,
  data: {
    updatephonetag: true,
    usertypename: '学校管理员',
    userid: 70147,
    institution: '数字化课堂循证实验室',
    uname: 'teacher1',
    institutionId: 99,
    level: '1',
    usertype: '1',
    avatar: 'https://www.eduku.cn/upload/resources/files/api/v1/user/70147_t/2024-09-18/a.png',
    institutionName: '数字化课堂循证实验室',
    name: '联课',
    phone: '',
  },
};

describe('normalizeEdukuProfile', () => {
  it('normalizes the live vendor response and maps usertype 1 to admin', () => {
    const profile = normalizeEdukuProfile(liveVendorData.data);
    expect(profile).not.toBeNull();
    expect(profile).toMatchObject({
      edukuUserid: '70147',
      username: 'teacher1',
      nick: '联课',
      headimg: 'https://www.eduku.cn/upload/resources/files/api/v1/user/70147_t/2024-09-18/a.png',
      role: '0',
      rolename: '学校管理员',
      usertype: '1',
      schoolid: '99',
      schoolName: '数字化课堂循证实验室',
      updatephonetag: true,
      edukuOpenid: null,
    });
  });

  it('maps any non-admin usertype to the viewer role', () => {
    for (const usertype of ['2', '3', '4', '5', 'teacher', '100']) {
      const profile = normalizeEdukuProfile({ ...liveVendorData.data, usertype });
      expect(profile?.role).toBe('3');
      expect(profile?.usertype).toBe(usertype);
    }
  });

  it('accepts a numeric usertype', () => {
    const profile = normalizeEdukuProfile({ ...liveVendorData.data, usertype: 1 });
    expect(profile?.role).toBe('0');
  });

  it('rejects a payload without userid', () => {
    const { userid: _removed, ...rest } = liveVendorData.data;
    expect(normalizeEdukuProfile(rest)).toBeNull();
  });

  it('tolerates the original doc field names as fallbacks', () => {
    const profile = normalizeEdukuProfile({
      ...liveVendorData.data,
      uname: '',
      name: '',
      avatar: '',
      usertypename: '',
      institutionName: '',
      // Doc-era fallbacks:
      username: 'docuser',
      nick: 'docnick',
      headimg: 'https://doc/avatar.png',
      rolename: 'docrole',
      schoolname: 'docschool',
    });
    expect(profile).toMatchObject({
      username: 'docuser',
      nick: 'docnick',
      headimg: 'https://doc/avatar.png',
      rolename: 'docrole',
      schoolName: 'docschool',
    });
  });
});

describe('extractEdukuUserProfile', () => {
  it('extracts the profile from the live { success, data } wrapper', () => {
    const result = extractEdukuUserProfile(liveVendorData);
    expect('profile' in result).toBe(true);
    if ('profile' in result) {
      expect(result.profile.edukuUserid).toBe('70147');
      expect(result.profile.role).toBe('0');
    }
  });

  it('accepts a bare profile object', () => {
    const result = extractEdukuUserProfile(liveVendorData.data);
    expect('profile' in result).toBe(true);
  });

  it('maps a vendor refusal (msg body) to a failure detail', () => {
    const result = extractEdukuUserProfile({ msg: '令牌过期或非法', code: '500' });
    expect(result).toEqual({ failure: { detail: '令牌过期或非法' } });
  });

  it('maps success:false to a failure detail', () => {
    const result = extractEdukuUserProfile({ success: false, data: { msg: '签名错误' } });
    expect('failure' in result).toBe(true);
  });

  it('reports the missing-userid failure for an unrecognized profile', () => {
    const result = extractEdukuUserProfile({ success: true, data: { foo: 'bar' } });
    expect('failure' in result).toBe(true);
    if ('failure' in result) expect(result.failure.detail).toContain('userid');
  });

  it('rejects non-object payloads', () => {
    const result = extractEdukuUserProfile('not an object');
    expect(result).toEqual({ failure: { detail: 'response is not an object' } });
  });
});
