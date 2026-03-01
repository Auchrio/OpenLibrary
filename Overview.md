# Overview

This project aims to give users acess to a wide range of books for free, with no download limit or authentication requirements, it will do this by utilising free file hosting and a modular library source control system to ensure there is no single point of failure, the project dooes not rely on any external servers to operate, so by cloning the project locally, you will forever have access to it.

## Modular Librarys
Modular Librarys are the core of the project, it utilizes a modular loading system to initialise and read library content, and provide users with download links, the structure of a modular library is as follows:
- lib.json <-- A file which provides the file index for the whole library, this file can be encrypted to provide users with access gating to content, this file can also be used to link to other modular librarys, creating a web of librarys which can be inported with ease.
- datafile.enc <-- the format of the files is encrypted using AES-256-GCM encryption, this prevents automatic content scanning from flagging content, even if the decryption key is widely known.

### lib.json
An example of what a lib.json file might look like is shown below.
```json
{
    "name": "Display Name of Modular Library",
    "encryption_type": 0,
    "links" {
        "Display Name of Other Library": {
            "link": "example.com".
            "key": 0,
        },
        "Display Name of Other Library": {
            "link": "example.com".
            "key": 0,
        }
    }
    "index": {
        "<id>": {
            "title": "Mistborn",
            "series": "Mistborn",
            "series_index": 1.0,
            "author": "Brandon Sanderson",
            "source": "<id>.enc",
            "source_cover": "<id>.enc",
            "source_key": "<uuid>"
        },
        "<id>": {
            "title": "The Well of Ascension",
            "series": "Mistborn",
            "series_index": 2.0,
            "author": "Brandon Sanderson",
            "source": {
                "epub": "<id>.enc",
                "mobi": "<id>.enc",
            },
            "source_cover": "<id>.enc",
            "source_key": "<uuid>"
        },
        "<id>": {
            "title": "The Hero of Ages",
            "series": "Mistborn",
            "series_index": 3.0,
            "author": "Brandon Sanderson",
            "source": "<id>.enc",
            "source_cover": "<id>.enc",
            "source_key": "<uuid>"
        },
    }
}
```
In normal operation, the index field would instead contain an encrypted string, which when decrypted with the encryption key (encrypted with a key `0` in the case of encryption type `0`, and the specified key if encryption type of `1`)

#### Library Creation
Due to the simple nature of the library, one can be created with the simple library cli tool, written in golang, accepts the follwing arguments:
```sh
library <input-folder> <output-folder> <encryption-key (optional)>
```
This command takes an input folder of books, builds the index based on the inbuilt titles of the ("epub", or "mobi") files, it also gets information such as Author, Series, and Series Index from the books metadata, detects when multiple formats of the same book is present and combines them into one index, extracts the covers of the books (prioritising the epub format) and saves them seprately as a cover file, then writes the index to the output folder and encrypts the files with ether a key of 0, or the specified key.

## Module Loading
The website is able to load these modular librarys from a url, currently the following platorms are supported for url import:
- Github Repositorys <-- Files are loaded through the RAW datalink provided by github.
    - In format such as `https://raw.githubusercontent.com/zephyrus-development/zephyrus-cli/refs/heads/main`
- Raw URL <-- Files are loaded through raw web requests.

