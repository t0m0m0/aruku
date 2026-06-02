part of 'search_screen.dart';

class _SuggestionTile extends StatelessWidget {
  const _SuggestionTile({
    required this.name,
    required this.address,
    required this.query,
    required this.onTap,
  });

  final String name;
  final String address;
  final String query;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final lowerName = name.toLowerCase();
    final lowerQuery = query.toLowerCase();
    final matchStart = lowerName.indexOf(lowerQuery);

    return InkWell(
      onTap: onTap,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 22, vertical: 12),
        child: Row(
          children: [
            Container(
              width: 38,
              height: 38,
              decoration: BoxDecoration(
                color: c.moss50,
                borderRadius: BorderRadius.circular(12),
              ),
              child: Center(child: Ic.pin(size: 18, color: c.moss600)),
            ),
            const SizedBox(width: 14),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  matchStart >= 0
                      ? RichText(
                          overflow: TextOverflow.ellipsis,
                          text: TextSpan(
                            style: jpStyle(
                              size: 16,
                              weight: FontWeight.w700,
                              color: c.ink,
                            ),
                            children: [
                              if (matchStart > 0)
                                TextSpan(text: name.substring(0, matchStart)),
                              TextSpan(
                                text: name.substring(
                                  matchStart,
                                  matchStart + query.length,
                                ),
                                style: TextStyle(
                                  color: c.moss700,
                                  backgroundColor: c.moss100,
                                ),
                              ),
                              TextSpan(
                                text: name.substring(matchStart + query.length),
                              ),
                            ],
                          ),
                        )
                      : Text(
                          name,
                          overflow: TextOverflow.ellipsis,
                          style: jpStyle(
                            size: 16,
                            weight: FontWeight.w700,
                            color: c.ink,
                          ),
                        ),
                  const SizedBox(height: 2),
                  Text(
                    address,
                    overflow: TextOverflow.ellipsis,
                    style: jpStyle(
                      size: 12,
                      weight: FontWeight.w500,
                      color: c.ink3,
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}
