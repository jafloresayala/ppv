-- SQLite
SELECT mpn, internal_pn, best_source, best_price_usd, std_price_usd, best_supplier, best_plant, best_mpn, last_po_date, window_days, computed_at, valid_date, origin, payload_json
FROM mpn_best
WHERE best_plant IS NOT NULL;