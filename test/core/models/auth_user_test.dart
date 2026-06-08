import 'package:aruku/core/models/auth_user.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('メールユーザーは isGuest=false', () {
    const u = AuthUser(uid: 'u1', email: 'a@example.com');
    expect(u.isGuest, isFalse);
    expect(u.email, 'a@example.com');
  });

  test('email が null なら isGuest=true（匿名）', () {
    const u = AuthUser(uid: 'g1');
    expect(u.isGuest, isTrue);
    expect(u.email, isNull);
  });

  test('uid と email が等しければ == で等価', () {
    expect(
      const AuthUser(uid: 'u1', email: 'a@example.com'),
      const AuthUser(uid: 'u1', email: 'a@example.com'),
    );
  });

  test('表示名はメール、ゲストは「ゲスト」', () {
    expect(
      const AuthUser(uid: 'u1', email: 'a@example.com').label,
      'a@example.com',
    );
    expect(const AuthUser(uid: 'g1').label, 'ゲスト');
  });
}
