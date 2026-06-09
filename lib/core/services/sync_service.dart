import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../models/sync_data.dart';

/// クラウド同期ストアの抽象。テストではフェイクに差し替える。
abstract interface class SyncService {
  /// ユーザーの同期ドキュメントを取得する。未保存なら null。
  Future<SyncData?> fetch(String uid);

  /// ユーザーの同期ドキュメントを丸ごと上書き保存する。
  Future<void> push(String uid, SyncData data);
}

/// Cloud Firestore による [SyncService] 実装。
/// `userSync/{uid}` ドキュメント 1 件にスナップショットを格納する。
class FirestoreSyncService implements SyncService {
  FirestoreSyncService(this._db);

  static const String _collection = 'userSync';

  final FirebaseFirestore _db;

  DocumentReference<Map<String, dynamic>> _doc(String uid) =>
      _db.collection(_collection).doc(uid);

  @override
  Future<SyncData?> fetch(String uid) async {
    final snap = await _doc(uid).get();
    final data = snap.data();
    return data == null ? null : SyncData.fromJson(data);
  }

  @override
  Future<void> push(String uid, SyncData data) => _doc(uid).set(data.toJson());
}

final syncServiceProvider = Provider<SyncService>(
  (_) => FirestoreSyncService(FirebaseFirestore.instance),
);
