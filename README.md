# kude

**Kude** on pieni tiedosto, jossa on vain kaksi asiaa: **resursseja** ja **linkkejä**.
Resurssi on tekstipala, kuva tai mikä tahansa muu tavujoukko, ja sen nimi on sen hash.
Linkki on kolmikko: mistä, predikaatti, mihin. Blogin lukujärjestys on `seuraava`-linkkien ketju.

Määrittely: [Anything is linkable](https://claude.ai/artifact/1KFh5XGoMksSgrFoensuo9). Tekninen kuvaus englanniksi: [docs/technical-description.md](docs/technical-description.md).

Tämä repo sisältää:

| Osa | Polku | Mitä se tekee |
|---|---|---|
| Ydin | `src/core` | tietomalli, tiedostomuoto, osoitteet, allekirjoitus, Markdown-jakaja, EXIF, näkymät. Ei riippuvuuksia; toimii selaimessa ja Nodessa (Web Crypto). |
| Selain | `src/web`, `web/` | katselin (blogi, galleria, aikajana) ja lohkoeditori |
| Komentorivi | `src/cli` | `kude pack/unpack/import/info/verify/sign/keygen/cat` |

## Käyttö

```sh
npm install
npm run example      # rakentaa web/esimerkit/*.kude
npm run dev          # http://localhost:8000, katselin ja editori
npm test
```

Katselin avaa kuteen osoitteesta: `index.html?src=esimerkit/seikkailu.kude&nakyma=galleria`.
Kuvaus luetaan ensin, ja kuvat haetaan Range-pyynnöillä vasta, kun ne tulevat näkyviin.
Jos palvelin ei tue Rangea, tiedosto haetaan kerralla.

```sh
npm run build:lib
node dist/cli/kude.js import teksti.md retki.kude --type Trip   # Markdown paloiksi, kuvalohkot kuviksi
node dist/cli/kude.js info retki.kude
node dist/cli/kude.js unpack retki.kude retki/                  # yksi tiedosto per resurssi + TSV:t
node dist/cli/kude.js pack retki/ retki.kude --key avain.json   # muokatut palat saavat korvaa-linkin
node dist/cli/kude.js keygen avain.json                         # did:key (Ed25519)
node dist/cli/kude.js verify retki.kude
```

## Tiedostomuoto

Esikuva on glTF:n GLB: otsake ja kolme osaa, kukin `[pituus u32][tyyppi u32][data]`.

```
otsake   "KUDE", versio 1, kokonaispituus
HEAD     {"author": "did:key:…", "alg": "Ed25519", "signature": "…"}
JSON     kuvaus: {"resources": {columns, rows}, "links": {columns, rows}}
BIN      upotettujen resurssien tavut: ensin metatieto, tekstit ja suttukuvat, sitten kuvat
```

- **resurssit**: `hash, mime, time, author, offset, length, url`. Rivi 0 on root, eli schema.org-metatieto JSON-LD:nä.
  Upotetulla resurssilla on `offset` ja `length`, linkatulla `url`.
- **linkit**: `from, predicate, to`. Kuteen sisäiset päät ovat lyhyitä hasheja: 7 merkkiä, pidempi vain törmäyksessä.
  Kuteesta puuttuvaan resurssiin viittaava hash kirjoitetaan täytenä, esimerkiksi `korvaa`-linkissä.
- Tuntemattomat sarakkeet, osat ja predikaatit säilytetään tai ohitetaan, joten laajennukset eivät riko vanhoja lukijoita.
- **Kuteen tunniste** on kuvauksen hash: `kude:<hash>`. Allekirjoitus lasketaan samasta hashista, joten se kattaa
  myös kaiken sisällön.
- Hash on SHA-256. Jokainen ladattu resurssi tarkistetaan hashiaan vasten.

Ytimen predikaatit ovat `alku`, `seuraava`, `lähde`, `korvaa` ja `esikatselu`. Muut ovat URI-osoitteita, esim. `schema:about`.

### Purettu muoto

`kude unpack` kirjoittaa kansion, jota voi muokata ja versioida gitillä:

```
juuri.json       root-metatieto
a1b2c3d.md       yksi tiedosto per resurssi (lyhyt hash + pääte)
resurssit.tsv    tiedosto, hash, mime, aika, tekijä, url (rivi 0 = root)
linkit.tsv       mistä, predikaatti, mihin (päät tiedostoniminä tai osoitteina)
```

Kappaleen muokkaus muuttaa yhtä tiedostoa, ja järjestyksen muutos muuttaa vain `linkit.tsv`:tä.
`kude pack` huomaa muokatut tiedostot `resurssit.tsv`:n hashista ja lisää `korvaa`-linkin vanhaan versioon.

## Editori

- Jokainen lohko on resurssi, ja lohkojen järjestys on `seuraava`-ketju. Siirto muuttaa vain linkkejä.
- Muokkaus luo uuden palan ja `korvaa`-linkin vanhaan. Tyhjä rivi tekstissä jakaa sen useaksi palaksi.
- Kuvasta luetaan EXIF-kuvaushetki aikaleimaksi, ja siitä tehdään noin 32 px:n suttukuva `esikatselu`-linkillä.
- **Tarkistus ennen tallennusta:** kuvat, joissa on sijainti, näytetään, ja tekijä valitsee, julkaistaanko sijainti.
  Sijainti poistetaan häviöttömästi nollaamalla EXIFin GPS-kentät, joten kuvan suunta ja aika säilyvät.
- Allekirjoitusavain (did:key) luodaan ja säilytetään selaimessa. Lataa se talteen.

## Rajaukset tässä versiossa

- Markdown-jakaja yksinkertaistaa CommonMarkia: väljä lista jakautuu kohdittain (ks. `src/core/markdown.ts`).
- Sama pala kahdesti lukujärjestyksessä hylätään (määrittelyn avoin kysymys).
- Komentorivi ei tee suttukuvia (Nodessa ei ole canvasia). Ne syntyvät, kun kuva lisätään selaimessa.
- Reitit (GPX/FIT), kartta, kaaviot ja varustenäkymä eivät vielä ole mukana. Ydin tukee niitä tavallisina resursseina.
- Salaus ja `kude:<tekijä>/<nimi>`-osoitteiden ratkaisija puuttuvat. `staticLoader` ja `walk` hoitavat rekursion
  staattiselta palvelimelta.
