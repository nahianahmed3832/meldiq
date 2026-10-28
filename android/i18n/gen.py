"""Writes res/values{,-zh-rCN,-bn}/strings.xml from strings.py, strings_account.xml from strings_account.py and
strings_workspace.xml from strings_workspace.py (docs/LANGUAGES.md). Run: python3 -I -B android/i18n/gen.py (-B: don't rewrite the tracked __pycache__)."""
import sys, re, os
sys.path.insert(0, os.path.dirname(__file__))
from strings import S
from strings_account import S as ACCOUNT
from strings_workspace import S as WORKSPACE
from strings_apps import S as APPS
from strings_meldiq import S as MELDIQ
from strings_round6 import S as ROUND6
from strings_round7 import S as ROUND7
from strings_meldiq2 import S as MELDIQ2
from strings_round3 import S as ROUND3
from strings_keybackup import S as KEYBACKUP
from strings_community import S as COMMUNITY
from strings_navigation import S as NAVIGATION
from strings_parity import S as PARITY
from strings_mojo import S as MOJO
res = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "app", "src", "main", "res")
# Every key must be unique across the tables (Android merges them into one namespace).
_seen = {}
for _name, _table in [("strings", S), ("strings_account", ACCOUNT), ("strings_workspace", WORKSPACE), ("strings_apps", APPS), ("strings_meldiq", MELDIQ), ("strings_round6", ROUND6), ("strings_round7", ROUND7), ("strings_meldiq2", MELDIQ2), ("strings_round3", ROUND3), ("strings_keybackup", KEYBACKUP), ("strings_community", COMMUNITY), ("strings_navigation", NAVIGATION), ("strings_parity", PARITY), ("strings_mojo", MOJO)]:
    for _k in _table:
        if _k in _seen:
            raise SystemExit(f"duplicate string key {_k!r} in {_name} and {_seen[_k]}")
        _seen[_k] = _name
def esc(v):
    v = v.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    v = re.sub(r'(?<!\\)"', r'\\"', v)
    v = re.sub(r"(?<!\\)'", r"\\'", v)
    if v[:1] in ("@", "?"):  # a leading @ or ? would make Android read the value as a resource reference
        v = "\\" + v
    return v
brand = {
  "en": ("Private by design. Connected by everyone.",),
  "zh": ("设计即隐私，连接每一个人。",),
  "bn": ("নকশাতেই গোপনীয়। সবার সঙ্গে সংযুক্ত।",),
}
for lang, folder, idx in [("en", "values", 0), ("zh", "values-zh-rCN", 1), ("bn", "values-bn", 2)]:
    os.makedirs(f"{res}/{folder}", exist_ok=True)
    out = ['<?xml version="1.0" encoding="utf-8"?>', '<!-- Interface strings (docs/LANGUAGES.md). Generated from one table so every language has every key. -->', '<resources>']
    if lang == "en":
        out += ['    <string name="app_name" translatable="false">Meldiq</string>', '    <string name="brand_attribution" translatable="false">Meldiq by GriipBuddy</string>']
    out.append(f'    <string name="brand_tagline">{esc(brand[lang][0])}</string>')
    for k, v in S.items():
        out.append(f'    <string name="{k}">{esc(v[idx])}</string>')
    out.append('</resources>')
    open(f"{res}/{folder}/strings.xml", "w").write("\n".join(out) + "\n")
    print(folder, len(S) + (3 if lang == "en" else 1))
    # Orbit 2.0 account strings: their own table and file (strings_account.py).
    acct = ['<?xml version="1.0" encoding="utf-8"?>', '<!-- Orbit 2.0 account strings (docs/LANGUAGES.md). Generated from strings_account.py. -->', '<resources>']
    for k, v in ACCOUNT.items():
        acct.append(f'    <string name="{k}">{esc(v[idx])}</string>')
    acct.append('</resources>')
    open(f"{res}/{folder}/strings_account.xml", "w").write("\n".join(acct) + "\n")
    print(folder, "account", len(ACCOUNT))
    # Workspace administration strings (2026-10-19): strings_workspace.py.
    ws = ['<?xml version="1.0" encoding="utf-8"?>', '<!-- Workspace administration strings (docs/LANGUAGES.md). Generated from strings_workspace.py. -->', '<resources>']
    for k, v in WORKSPACE.items():
        ws.append(f'    <string name="{k}">{esc(v[idx])}</string>')
    ws.append('</resources>')
    open(f"{res}/{folder}/strings_workspace.xml", "w").write("\n".join(ws) + "\n")
    print(folder, "workspace", len(WORKSPACE))
    # Custom roles, apps and administration strings (2026-10-19): strings_apps.py.
    ap = ['<?xml version="1.0" encoding="utf-8"?>', '<!-- Roles, apps and administration strings (docs/LANGUAGES.md). Generated from strings_apps.py. -->', '<resources>']
    for k, v in APPS.items():
        ap.append(f'    <string name="{k}">{esc(v[idx])}</string>')
    ap.append('</resources>')
    open(f"{res}/{folder}/strings_apps.xml", "w").write("\n".join(ap) + "\n")
    print(folder, "apps", len(APPS))
    # Meldiq design, messaging and media strings (2026-10-19 round 5): strings_meldiq.py.
    md = ['<?xml version="1.0" encoding="utf-8"?>', '<!-- Meldiq design, messaging and media strings (docs/LANGUAGES.md). Generated from strings_meldiq.py. -->', '<resources>']
    for k, v in MELDIQ.items():
        md.append(f'    <string name="{k}">{esc(v[idx])}</string>')
    md.append('</resources>')
    open(f"{res}/{folder}/strings_meldiq.xml", "w").write("\n".join(md) + "\n")
    print(folder, "meldiq", len(MELDIQ))
    # Round 6 strings (2026-10-19): strings_round6.py.
    r6 = ['<?xml version="1.0" encoding="utf-8"?>', '<!-- Round 6 strings (docs/LANGUAGES.md). Generated from strings_round6.py. -->', '<resources>']
    for k, v in ROUND6.items():
        r6.append(f'    <string name="{k}">{esc(v[idx])}</string>')
    r6.append('</resources>')
    open(f"{res}/{folder}/strings_round6.xml", "w").write("\n".join(r6) + "\n")
    print(folder, "round6", len(ROUND6))
    # Round 7 strings (2026-10-19): strings_round7.py.
    r7 = ['<?xml version="1.0" encoding="utf-8"?>', '<!-- Round 7 strings (docs/LANGUAGES.md). Generated from strings_round7.py. -->', '<resources>']
    for k, v in ROUND7.items():
        r7.append(f'    <string name="{k}">{esc(v[idx])}</string>')
    r7.append('</resources>')
    open(f"{res}/{folder}/strings_round7.xml", "w").write("\n".join(r7) + "\n")
    print(folder, "round7", len(ROUND7))
    # Meldiq 2.0 strings (2026-10-20): strings_meldiq2.py.
    m2 = ['<?xml version="1.0" encoding="utf-8"?>', '<!-- Meldiq 2.0 strings (docs/LANGUAGES.md). Generated from strings_meldiq2.py. -->', '<resources>']
    for k, v in MELDIQ2.items():
        m2.append(f'    <string name="{k}">{esc(v[idx])}</string>')
    m2.append('</resources>')
    open(f"{res}/{folder}/strings_meldiq2.xml", "w").write("\n".join(m2) + "\n")
    print(folder, "meldiq2", len(MELDIQ2))
    # Round 3 strings (2026-10-21): strings_round3.py.
    r3 = ['<?xml version="1.0" encoding="utf-8"?>', '<!-- Round 3 strings (docs/LANGUAGES.md). Generated from strings_round3.py. -->', '<resources>']
    for k, v in ROUND3.items():
        r3.append(f'    <string name="{k}">{esc(v[idx])}</string>')
    r3.append('</resources>')
    open(f"{res}/{folder}/strings_round3.xml", "w").write("\n".join(r3) + "\n")
    print(folder, "round3", len(ROUND3))
    # Key backup strings (2026-10-21): strings_keybackup.py.
    kb = ['<?xml version="1.0" encoding="utf-8"?>', '<!-- Key backup strings (docs/LANGUAGES.md). Generated from strings_keybackup.py. -->', '<resources>']
    for k, v in KEYBACKUP.items():
        kb.append(f'    <string name="{k}">{esc(v[idx])}</string>')
    kb.append('</resources>')
    open(f"{res}/{folder}/strings_keybackup.xml", "w").write("\n".join(kb) + "\n")
    print(folder, "keybackup", len(KEYBACKUP))
    # Community strings (2026-10-21): strings_community.py.
    cm = ['<?xml version="1.0" encoding="utf-8"?>', '<!-- Community strings (docs/LANGUAGES.md). Generated from strings_community.py. -->', '<resources>']
    for k, v in COMMUNITY.items():
        cm.append(f'    <string name="{k}">{esc(v[idx])}</string>')
    cm.append('</resources>')
    open(f"{res}/{folder}/strings_community.xml", "w").write("\n".join(cm) + "\n")
    print(folder, "community", len(COMMUNITY))
    # Navigation strings (2026-10-21, Discord reference round): strings_navigation.py.
    nv = ['<?xml version="1.0" encoding="utf-8"?>', '<!-- Navigation and community strings (docs/LANGUAGES.md). Generated from strings_navigation.py. -->', '<resources>']
    for k, v in NAVIGATION.items():
        nv.append(f'    <string name="{k}">{esc(v[idx])}</string>')
    nv.append('</resources>')
    open(f"{res}/{folder}/strings_navigation.xml", "w").write("\n".join(nv) + "\n")
    print(folder, "navigation", len(NAVIGATION))
    # Android and Meldiq Web parity strings (2026-10-28): strings_parity.py.
    wp = ['<?xml version="1.0" encoding="utf-8"?>', '<!-- Android and Meldiq Web parity strings (docs/LANGUAGES.md). Generated from strings_parity.py. -->', '<resources>']
    for k, v in PARITY.items():
        wp.append(f'    <string name="{k}">{esc(v[idx])}</string>')
    wp.append('</resources>')
    open(f"{res}/{folder}/strings_parity.xml", "w").write("\n".join(wp) + "\n")
    # Meldiq Mojo strings (2026-10-28): strings_mojo.py.
    mj = ['<?xml version="1.0" encoding="utf-8"?>', '<!-- Meldiq Mojo strings (docs/MOJO_ANDROID.md). Generated from strings_mojo.py. -->', '<resources>']
    for k, v in MOJO.items():
        mj.append(f'    <string name="{k}">{esc(v[idx])}</string>')
    mj.append('</resources>')
    open(f"{res}/{folder}/strings_mojo.xml", "w").write("\n".join(mj) + "\n")
    print(folder, "mojo", len(MOJO))
