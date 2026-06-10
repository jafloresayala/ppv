import cache, pickle

keys = cache._client.keys("ppv:ses:*")
raw  = cache._client.get(keys[0])
data = pickle.loads(raw)
df   = data["df"]

mat = "1149807+01_A"
sub = df[df["Material_Number"].astype(str) == mat].copy()
print(f"Rows for {mat}: {len(sub)}")

if sub.empty:
    print("Material not found in session.")
else:
    cols_show = [
        "Total_Variance_Amount_num",
        "P_Price_difference_num",
        "PPDifference_currency",
        "Report_Currency",
        "Plant",
        "YearMonth",
    ]
    for col in cols_show:
        if col not in sub.columns:
            print(f"  {col}: MISSING")
            continue
        if col in ("Total_Variance_Amount_num", "P_Price_difference_num", "PPDifference_currency"):
            print(f"  {col} sum = {sub[col].sum():,.4f}")
        else:
            print(f"  {col} unique = {sub[col].unique().tolist()[:15]}")

    print()
    print("Per-plant breakdown:")
    for col in ("Total_Variance_Amount_num", "P_Price_difference_num", "PPDifference_currency"):
        if col in sub.columns and "Plant" in sub.columns:
            grp = sub.groupby("Plant")[col].sum()
            print(f"\n  {col}:")
            for plant, val in grp.items():
                print(f"    Plant {plant}: {val:,.4f}")

    print()
    print("Sample rows (first 5):")
    cols_sample = [c for c in ["YearMonth","Plant","Report_Currency","P_Price_difference_num","PPDifference_currency"] if c in sub.columns]
    print(sub[cols_sample].head(10).to_string(index=False))
