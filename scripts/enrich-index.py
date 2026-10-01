#!/usr/bin/env python3
"""Enrich coloring-library/index.json.

Adds, for every sheet:

  tags         richer keyword list (filename words + synonyms + category words)
  desc         a one-line human description
  difficulty   easy | medium | detailed   (from the image itself)
  age          suggested age band
  areas        number of enclosed areas to color (measured, full resolution)
  ink_ratio    fraction of the page that is line art
  size         "1080x1400" etc.
  ip           third-party character/brand the sheet depicts, else null

`q` (the client's search haystack) is widened with the new tags so the
existing in-app search picks them up.

usage: enrich_index.py [--lib DIR] [--limit N] [--report-only]
"""
import argparse, collections, json, os, re, sys
import numpy as np
from multiprocessing import Pool
from PIL import Image
from scipy import ndimage

_HERE = os.path.dirname(os.path.abspath(__file__))
LIB = os.environ.get("COLORING_LIB") or os.path.join(os.path.dirname(_HERE), "coloring-library")
BIG = np.array([[0, 1, 0], [1, 1, 1], [0, 1, 0]])          # 4-connectivity

STOP = set("coloring coloring page pages printable free print a an the of on in with and to "
           "for kids kid children child color color".split())

SYNONYM = {
    "xmas": "christmas", "santa": "christmas", "reindeer": "christmas",
    "snowman": "christmas", "bunny": "easter rabbit", "cupid": "valentine",
    "shamrock": "st-patricks", "clover": "st-patricks", "leprechaun": "st-patricks",
    "pumpkin": "halloween", "ghost": "halloween", "witch": "halloween",
    "spooky": "halloween", "turkey": "thanksgiving", "fireworks": "july-4th",
    "patriotic": "july-4th", "kitten": "cat", "kitty": "cat", "puppy": "dog",
    "dino": "dinosaur", "unicorn": "fantasy", "mermaid": "fantasy",
    "princess": "fantasy", "dragon": "fantasy", "rocket": "space",
    "astronaut": "space", "tractor": "farm", "barn": "farm",
}

# Third-party properties / real people. Purely informational: lets the library
# be filtered or quarantined without eyeballing 6k filenames.
IP = {
    "bluey": "Bluey", "bingo-heeler": "Bluey",
    "poppy-playtime": "Poppy Playtime", "huggy-wuggy": "Poppy Playtime",
    "kissy-missy": "Poppy Playtime", "catnap": "Poppy Playtime",
    "smurfs": "The Smurfs", "smurf": "The Smurfs",
    "pokemon": "Pokémon", "pikachu": "Pokémon", "eevee": "Pokémon",
    "mario": "Super Mario", "luigi": "Super Mario", "yoshi": "Super Mario",
    "sonic": "Sonic the Hedgehog",
    "minecraft": "Minecraft", "creeper": "Minecraft",
    "hello-kitty": "Hello Kitty", "sanrio": "Sanrio",
    "my-melody": "Sanrio", "cinnamoroll": "Sanrio", "kuromi": "Sanrio",
    "barbie": "Barbie",
    "spider": "Spider-Man", "spiderman": "Spider-Man", "spider-man": "Spider-Man",
    "iron-man": "Marvel", "avengers": "Marvel", "marvel": "Marvel",
    "superman": "DC Comics", "batman": "DC Comics", "dc-comics": "DC Comics",
    "stitch": "Disney", "moana": "Disney", "elsa": "Disney", "frozen": "Disney",
    "mickey": "Disney", "disney": "Disney", "encanto": "Disney",
    "dory": "Finding Dory", "nemo": "Finding Nemo",
    "dora": "Dora the Explorer",
    "one-piece": "One Piece", "luffy": "One Piece", "zoro": "One Piece",
    "naruto": "Naruto", "goku": "Dragon Ball", "dragon-ball": "Dragon Ball",
    "demon-slayer": "Demon Slayer", "akaza": "Demon Slayer",
    "animal-crossing": "Animal Crossing",
    "spongebob": "SpongeBob", "patrick-star": "SpongeBob",
    "scooby": "Scooby-Doo", "paw-patrol": "PAW Patrol",
    "harry-potter": "Harry Potter", "minion": "Minions", "minions": "Minions",
    "wednesday": "Wednesday", "stranger-things": "Stranger Things",
    "labubu": "Labubu", "roblox": "Roblox", "fortnite": "Fortnite",
    "among-us": "Among Us", "peppa": "Peppa Pig", "gabby": "Gabby's Dollhouse",
    "tom-and-jerry": "Tom and Jerry", "looney": "Looney Tunes",
    "taylor-swift": "Taylor Swift", "mrbeast": "MrBeast",
    "dwayne": "Dwayne Johnson", "the-rock": "Dwayne Johnson",
    "messi": "Lionel Messi", "mbappe": "Kylian Mbappé", "yamal": "Lamine Yamal",
    "trump": "Donald Trump", "biden": "Joe Biden",
    "tralalero": "Italian Brainrot", "brainrot": "Italian Brainrot",
    "bombardiro": "Italian Brainrot", "tung-tung": "Italian Brainrot",
    "sahur": "Italian Brainrot", "ballerina-cappuccina": "Italian Brainrot",
    "gelato-monster": "Italian Brainrot", "sprunki": "Sprunki",
    "zed-zombies": "Z-O-M-B-I-E-S",
    "nike": "Nike", "labubu-": "Labubu",
}

CATS_ORDER = ["animals", "fantasy", "holidays", "nature", "food", "vehicles",
              "sports", "people", "birthday", "learning", "other"]


def load_index():
    with open(os.path.join(LIB, "index.json")) as f:
        return json.load(f)


def words_of(sheet_id):
    s = re.sub(r"-free$", "", sheet_id)
    s = re.sub(r"^free-", "", s)
    return [w for w in re.split(r"[-_]+", s) if w]


def metrics(path):
    with Image.open(path) as im:
        A = np.array(im.split()[3])
    ink = A > 100
    h, w = ink.shape
    bg = ~ink
    lab, n = ndimage.label(bg, structure=BIG)
    # regions touching the image edge are the page margin / outside the frame
    edge = np.unique(np.concatenate([lab[0, :], lab[-1, :], lab[:, 0], lab[:, -1]]))
    edge = set(int(x) for x in edge if x)
    sizes = ndimage.sum(bg, lab, index=np.arange(1, n + 1))
    areas = tiny = 0
    for i, sz in enumerate(sizes, start=1):
        if i in edge:
            continue
        if sz >= 6:
            areas += 1
        else:
            tiny += 1
    return {"areas": int(areas), "tiny": int(tiny),
            "ink_ratio": round(float(ink.mean()), 4),
            "size": f"{w}x{h}"}


def one(args):
    fname, sheet = args
    r = metrics(os.path.join(LIB, "full", fname))
    return {**sheet, **r, "id": sheet["id"]}


CACHE = os.path.join(LIB, ".metrics.json")


def collect_metrics(jobs, workers, refresh):
    """Per-sheet image metrics, cached in coloring-library/.metrics.json.

    The measurement is the slow part (a full-resolution connected-component
    pass per sheet), and the PNGs only change when the artwork does, so cache
    it keyed on (name, size, mtime).
    """
    key = {}
    for fname, sheet in jobs:
        path = os.path.join(LIB, "full", fname)
        st = os.stat(path)
        key[sheet["id"]] = [st.st_size, int(st.st_mtime)]
    cache = {}
    if not refresh and os.path.exists(CACHE):
        try:
            doc = json.load(open(CACHE))
            if doc.get("key") == key:
                cache = doc["metrics"]
                print(f"metrics: reusing {len(cache)} cached rows from {CACHE}")
        except (ValueError, KeyError):
            cache = {}
    if len(cache) == len(key):
        return cache
    print(f"metrics: measuring {len(jobs)} sheets…", flush=True)
    with Pool(workers) as p:
        rows = []
        for i, r in enumerate(p.imap(one, jobs, chunksize=8), 1):
            rows.append(r)
            if i % 1000 == 0:
                print(f"  {i}/{len(jobs)}", flush=True)
    cache = {r["id"]: {"areas": r["areas"], "tiny": r["tiny"],
                       "ink_ratio": r["ink_ratio"], "size": r["size"]} for r in rows}
    with open(CACHE, "w") as f:
        json.dump({"key": key, "metrics": cache}, f)
    print(f"metrics: wrote cache {CACHE}")
    return cache


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--report-only", action="store_true")
    ap.add_argument("--refresh-metrics", action="store_true")
    ap.add_argument("--workers", type=int, default=16)
    a = ap.parse_args()

    idx = load_index()
    sheets = idx["sheets"]
    jobs = [(s["id"] + ".png", s) for s in sheets]
    if a.limit:
        jobs = jobs[:a.limit]

    cache = collect_metrics(jobs, a.workers, a.refresh_metrics)
    out = []
    for fname, sheet in jobs:
        m = cache.get(sheet["id"])
        if not m:
            print("no metrics for", sheet["id"])
            continue
        out.append({**sheet, **m})

    # ---- difficulty cut points from the measured distribution
    ar = np.array([r["areas"] for r in out])
    pcts = {p: int(np.percentile(ar, p)) for p in (25, 50, 75, 90)}
    e_cut, m_cut = pcts[25], pcts[75]
    print("areas percentiles:", pcts, " cuts:", e_cut, m_cut)

    for r in out:
        words = words_of(r["id"])
        extra = [SYNONYM[w] for w in words if w in SYNONYM]
        qw = [w for w in words if w not in STOP]
        # `tags` is deliberately NOT shipped: q already carries the same words
        # plus the synonyms, and the index is fetched whole by the client.
        tags = sorted(set(qw + " ".join(extra).split()))
        a_ = r["areas"]
        diff = "easy" if a_ <= e_cut else ("medium" if a_ <= m_cut else "detailed")
        r["difficulty"] = diff
        r["age"] = {"easy": "3-6", "medium": "6-9", "detailed": "9+"}[diff]
        r["q"] = " ".join(sorted(set(r["q"].split()) | set(tags)
                                 | set(" ".join(extra).split())))
        cats = [c for c in CATS_ORDER if c in (r.get("cats") or []) and c != "other"]
        if not cats:
            cats = ["just-for-fun"]
        if len(cats) == 1:
            cats_txt = cats[0]
        elif len(cats) == 2:
            cats_txt = f"{cats[0]} and {cats[1]}"
        else:
            cats_txt = ", ".join(cats[:-1]) + f" and {cats[-1]}"
        phrase = {"easy": "a simple, easy-to-color",
                  "medium": "a moderately detailed",
                  "detailed": "a detailed"}[diff]
        r["desc"] = (f"{r['title']} — {phrase} {cats_txt} coloring page with "
                     f"about {a_} areas to color. Best for ages {r['age']}.")
        r["ip"] = next((v for k, v in IP.items() if k in r["id"]), None)
        r.pop("tiny", None)

    ip_counts = collections.Counter(r["ip"] for r in out if r["ip"])
    print("third-party properties found:", sum(ip_counts.values()), "sheets")
    for k, v in ip_counts.most_common(30):
        print(f"   {v:5d}  {k}")
    print("difficulty spread:", collections.Counter(r["difficulty"] for r in out))

    if a.report_only:
        return
    ip_sorted = sorted(out, key=lambda r: r["title"].lower())
    payload = {"count": len(ip_sorted), "sheets": ip_sorted,
               "generated_by": "scripts/enrich-index.py",
               "difficulty_cuts": {"easy_max_areas": int(e_cut), "medium_max_areas": int(m_cut)}}
    tmp = os.path.join(LIB, "index.json.new")
    with open(tmp, "w") as f:
        json.dump(payload, f)
    print("wrote", tmp, os.path.getsize(tmp), "bytes")


if __name__ == "__main__":
    main()
