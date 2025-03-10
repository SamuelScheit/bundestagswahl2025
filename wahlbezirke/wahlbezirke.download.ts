import type { ResultType } from "./scrape";
import { getUntergebieteWAS, getWahlbezirk, getWahlbezirkeWAS, getWahlbezirkeVotemanager } from "./wahlbezirke";
import fs from "fs";
import { landWahlkreise, wahlkreiseQuellen } from "./wahlkreise";

// @ts-ignore
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

process.on("unhandledRejection", (error) => {
	console.error(error);
});

process.on("uncaughtException", (error) => {
	console.error(error);
});

// const result = await getWahlbezirkeVotemanager();
// const result = await getWahlbezirkeVoteElect();
// const result = await getUntergebieteVoteElect(
// 	"https://www.wahlen-muenchen.de/ergebnisse/20250223bundestagswahl/ergebnisse_wahlkreis_219.html"
// );
// const result = await getWahlbezirk({ name: "", url: "https://votemanager.kdo.de/15084315/index.html", bundesland: "" });
// const bayern = landWahlkreise["9"].map((x) => (wahlkreiseQuellen as any)[x]);
// const result = await getWahlbezirkeWAS(bayern);
const result = await getWahlbezirkeWAS([wahlkreiseQuellen["1"]]);

// console.log(result);

const wahlbezirke = require("./data/wahlbezirke.json");
Object.assign(wahlbezirke, result);

// function reduce(x: ResultType): any {
// 	const results = {} as Record<string, any>;

// 	if (!x.zweitstimmen) {
// 		Object.entries(x).forEach(([key, value]) => {
// 			results[key] = reduce(value as any);
// 		});
// 		return results;
// 	}

// 	return x;
// }

// Object.entries(wahlbezirke).forEach(([gemeinde, wahlbezirke]) => {
// 	Object.entries(wahlbezirke as any).forEach(([bezirk, x]) => {
// 		const result = {} as any;
// 		const wahlbezirk = x as ResultType;

// 		if (!wahlbezirk.zweitstimmen) {
// 			delete (wahlbezirke as any)[bezirk];
// 			Object.assign(wahlbezirke as any, reduce(wahlbezirk));
// 		}
// 	});
// });

fs.writeFileSync(__dirname + "/data/wahlbezirke.json", JSON.stringify(wahlbezirke, null, "\t"));
