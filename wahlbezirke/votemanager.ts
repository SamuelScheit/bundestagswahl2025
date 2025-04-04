// @ts-ignore
import extractUrls from "extract-urls";
import { axiosWithRedirect, isFinalError } from "./axios";
import { defaultResult, getIdFromName, type Options, type ResultType } from "../wahlkreise/scrape";
import { behoerden_queue, concurrency, wahlbezirke_queue, wahleintrage_queue } from "./wahlbezirke";
import { cleanGemeindeName, gemeinden, getGemeinde, getGemeindeByUrl, getGemeindeByUrlOrNull } from "./gemeinden";
import PQueue from "p-queue";
import { wahlkreiseNamen, wahlkreiseQuellen } from "../wahlkreise/wahlkreise";
import axios from "axios";
import parse from "csv-parser";
import { assignOptional, csvParse } from "./util";

export async function votemanager(options: Options & { text: string }) {
	const { searchParams, origin, pathname } = new URL(options.url);
	const wahl_id = searchParams.get("wahl_id")!;
	const id = searchParams.get("id")!;

	const baseUrl = origin + pathname.replace("/praesentation/ergebnis.html", "");
	const apiUrl = baseUrl + (options.text.includes("../api") ? "/api/praesentation" : "/daten/api");

	console.log({ baseUrl, apiUrl, url: options.url });

	return votemanagerWithOptions({ url: apiUrl, wahl_id, ebene_id: id });
}

export interface VotemanagerConfig {
	links: {
		titel: string;
		text: string;
		url: string;
	}[];
	behoerden_links?: {
		header: {
			text: string;
			url: string;
		};
		links?: {
			text: string;
			url: string;
		}[];
	};
	eigene_texte: {
		gesamtergebnis: {};
		behoerden_startseite: {};
	};
	umgebung: {};
	behoerde: string;
	activate_log: boolean;
	homepage: string;
	impressum_url: string;
	datenschutz_url: string;
	barrierefreiheit_url: string;
	alle_wahltermine_link: string;
	logo: {
		src: string;
		link: string;
		alternativtext: string;
	};
	zeige_uebersicht_strassen_link: boolean;
	zeige_uebersicht_wahlraeume_link: boolean;
	lizenz: boolean;
	file_version: string;
	file_timestamp: string;
	server_hash: string;
}

export async function votemanagerWithOptions({
	ebene_id,
	url,
	wahl_id,
	name,
}: {
	url: string;
	wahl_id: string;
	ebene_id: string;
	name?: string;
}) {
	const results = await Promise.all([
		axiosWithRedirect<WahlErgebnis>(`${url}/wahl_${wahl_id}/ergebnis_${ebene_id}_0.json`, { responseType: "json" }),
		axiosWithRedirect<WahlErgebnis>(`${url}/wahl_${wahl_id}/ergebnis_${ebene_id}_1.json`, { responseType: "json" }),
	]);

	const result = defaultResult();

	const hasError = results.find((x) => !x.data.Komponente?.tabelle);
	if (hasError) {
		throw new Error(`${url} ${wahl_id} ${ebene_id} Keine Daten ${hasError.data.Komponente?.hinweis_auszaehlung || "Keine Ergebnisse"}`);
	}

	const [stimme1, stimme2] = results.map((x) => {
		const parteien = {} as Record<string, number>;
		let gültig = 0;
		let ungültig = 0;

		x.data.Komponente.tabelle.zeilen.forEach((row: any) => {
			parteien[row.label.labelKurz] = Number(row.zahl.replace(/\./g, "")) || 0;
		});

		x.data.Komponente.info.tabelle.zeilen.forEach((row: any) => {
			const zahl = Number(row.zahl.replace(/\./g, "")) || 0;
			if (row.label.labelKurz.includes("berechtigt")) {
				result.anzahl_berechtigte = zahl;
			} else if (row.label.labelKurz.includes("Wähler")) {
				result.anzahl_wähler = zahl;
			} else if (row.label.labelKurz.includes("ungültig")) {
				ungültig = zahl;
			} else if (row.label.labelKurz.includes("gültig")) {
				gültig = zahl;
			}
		});

		return { parteien, gültig, ungültig };
	});

	const { gebietsverlinkung } = results[0].data.Komponente;

	if (gebietsverlinkung && name) {
		var gemeinde = null as ReturnType<typeof getGemeinde> | null;

		gebietsverlinkung
			.find((x) => x.titel.includes("Mitgliedsgemeinden"))
			?.gebietslinks?.forEach((x) => {
				if (x.type !== "ergebnis") return;

				// gemeinde ||= getGemeinde(x.title, name);
			});

		const Wahlkreis = gebietsverlinkung.find((x) => x.titel.includes("Wahlkreis"));

		Wahlkreis?.gebietslinks?.forEach((x) => {
			if (x.type !== "ergebnis") return;
			if (x.title === "Bochum 1") {
				result.wahlkreis_id = "139";
				return;
			} else if (x.title === "Bochum 2") {
				result.wahlkreis_id = "140";
				return;
			}

			gemeinde ||= getGemeinde(name, x.title);
		});

		if (gemeinde) assignOptional(result, gemeinde);

		gebietsverlinkung
			.find((x) => x.titel.includes("Stadtbezirk"))
			?.gebietslinks?.forEach((x) => {
				if (x.type !== "ergebnis") return;

				if (x.title === "4 Bochum-Ost" || x.title === "3 Bochum-Nord") {
					result.wahlkreis_id = "140";
				}
			});

		if (!Wahlkreis && name === "Stadt Wuppertal") {
			// Wuppertal does not have a wahlkreis link if it is 102: Solingen – Remscheid – Wuppertal II
			result.wahlkreis_id = "102";
		}
	}

	result.erststimmen = stimme1;
	result.zweitstimmen = stimme2;

	return result;

	// https://wahlen.regioit.de/1/bt2025/05334002/praesentation/ergebnis.html?wahl_id=97&stimmentyp=1&id=ebene_2_id_114
	// https://wahlen.regioit.de/1/bt2025/05334002/daten/api/wahl_97/ergebnis_ebene_2_id_114_1.json
}

let results = [] as ResultType[];
const scraped = new Set<string>();
const promiseScraped = new Map<string, Promise<any>>();

const wahlkreiseStadt = new Set([
	"151", // Leipzig I
	"152", // Leipzig II
	// bochum doesn't have individual wahlbezirke csv files
	// "139", // Bochum I
	// "140", // Bochum II
	"258", // Stuttgart I
	"259", // Stuttgart II
]);

export type VotemanagerOpts = {
	url: string;
	name: string;
	html?: string;
	bundesland: string;
	tries?: number;
	onlySubgemeinden?: boolean;
};

export async function getWahlbezirkVotemanager(
	opts: {
		filter?: (opts: VotemanagerOpts) => boolean;
	} & VotemanagerOpts
) {
	if (opts.filter && !opts.filter(opts)) return results;

	opts.url = opts.url.replace("/index.html", "/");

	if (promiseScraped.has(opts.url)) return promiseScraped.get(opts.url);
	if (scraped.has(opts.url)) return [];
	scraped.add(opts.url);

	const promise = (async () => {
		try {
			console.log("getWahlbezirkVotemanager", opts.url);

			if (opts.html) {
				var { html, url } = opts;
			} else {
				var { data: html, status, url } = await axiosWithRedirect<string>(opts.url, { responseType: "text" });
				if (status >= 400) throw new Error(`Request failed with status code ${status}`);
			}

			const isVoteManager = html.includes("votemanager.de") || html.includes("termine.json") || html.includes("vue_index_container");
			if (!isVoteManager) {
				throw new Error("Not votemanager: " + opts.url);
			}

			// termine https://votemanager-da.ekom21cdn.de/06431001/index.html
			// termin übersicht https://wahl.gelsenkirchen.de/votemanager/20250223/05513000/praesentation/index.html
			// ergebnis https://votemanager-da.ekom21cdn.de/2025-02-23/06431001/praesentation/ergebnis.html?wahl_id=728&stimmentyp=0&id=ebene_-575_id_638

			if (!html.includes("termine.json")) {
				// all irrelevant because the used votemanager version is older than BTW2025
				// throw new Error("Keine BTW25 Ergebnisse (alte version)");
				const configUrl = new URL("../daten/api/config.json", url).href;
				const { data: config } = await axiosWithRedirect<VotemanagerConfig>(configUrl);

				if (!config.alle_wahltermine_link) throw new Error("Keine BTW25 Ergebnisse (alte version)");

				url = new URL(config.alle_wahltermine_link, url).href;
			}

			let base = url.replace("/index.html", "");
			if (base.endsWith("/")) base = base.slice(0, -1);

			const termineUrl = base + "/api/termine.json";

			const { data } = await axiosWithRedirect(termineUrl);
			const { termine } = data;

			if (!termine) throw new Error("INVALID RESPONSE: " + termineUrl + " " + opts.url);

			const btw25 = termine.find((x: any) => x.date === "23.02.2025");
			if (!btw25) throw new Error("Keine BTW25 Ergebnisse (Kein Termin)");

			// https://votemanager.kdo.de/15084590/../2025022302/15084590/praesentation/
			// https://votemanager.kdo.de/15084590/../2025022302/15084590/daten/api/termin.json
			const apiType = html.includes("../api") ? `/api/praesentation` : `/daten/api`;
			const apiEndpoint = base + "/" + btw25.url.replace("/praesentation/", apiType);
			const terminUrl = apiEndpoint + "/termin.json";

			const { data: termin } = await axiosWithRedirect<{ wahleintraege: Wahleintrag[] }>(terminUrl);
			let { wahleintraege } = termin;

			if (!wahleintraege) throw new Error("INVALID RESPONSE: " + opts.url + " " + terminUrl);

			wahleintraege = wahleintraege.filter((x) => x.stimmentyp.id === 1 && x.wahl.titel.toLowerCase().includes("bundestag"));
			if (wahleintraege.length <= 0) throw new Error("Keine BTW25 Ergebnisse (Kein Wahleintrag)");

			// https://votemanager.kdo.de/2025022302/15084590/daten/api/termin.json

			// console.log(name, terminUrl);

			const { data: config } = await axiosWithRedirect<VotemanagerConfig>(`${apiEndpoint}/config.json`, { responseType: "json" });

			if (!opts.name) opts.name = config.behoerde;

			// console.log(opts.name, base + "/" + btw25.url);
			const präsentationUrl = base + "/" + btw25.url;

			behoerden_queue.addAll(
				(config.behoerden_links?.links || [])
					.map((x) => {
						if (!x.url) return;
						if (!x.url.startsWith("../")) return { text: x.text, url: x.url };

						const newUrl = new URL(x.url, präsentationUrl);

						return { text: x.text, url: newUrl.href };
					})
					.filter((x) => x)
					.map((x) => async () => {
						try {
							await getWahlbezirkVotemanager({
								url: x!.url,
								name: x!.text,
								bundesland: opts.bundesland,
								filter: opts.filter,
							});
						} catch (error) {
							console.error("Error", error);
						}
					}),
				{
					priority: 1,
				}
			);

			let gemeinde = getGemeindeByUrl(präsentationUrl);
			if (opts.bundesland && gemeinde.bundesland_name !== opts.bundesland) {
				throw new Error(
					"Invalid gemeinde: " + opts.name + " " + url + " " + gemeinde.gemeinde_name + " " + gemeinde.bundesland_name
				);
			}
			if (!gemeinde) {
				console.log(config.behoerde, "NOT FOUND", cleanGemeindeName);
				return results;
			}

			if (!gemeinde.gemeinde_name && !gemeinde.verband_name && !opts.onlySubgemeinden) {
				console.log("NO GEMEINDE name", gemeinde, opts.name, config.behoerden_links?.header.text, url);
				// throw new Error("NO GEMEINDE name: " + gemeinde);
				getGemeindeByUrl(präsentationUrl);
			}

			var wahlräumeNachBezirkNr = {} as Record<string, Wahlraum>;
			var wahlräumeNachBezirkName = {} as Record<string, Wahlraum>;

			try {
				if (config.zeige_uebersicht_wahlraeume_link) {
					// const {
					// 	data: { wahlraeume },
					// } = await axiosWithRedirect<Wahlraeume>(`${apiEndpoint}/wahlraeume_uebersicht.json`, {});
					var { wahlräumeNachBezirkNr, wahlräumeNachBezirkName } = await getVotemanagerWahllokale(apiEndpoint, gemeinde);
				}
			} catch (error) {
				console.error("Error", error);
			}

			// console.log(gemeinde.gemeinde_name, opts.name);

			const queue = new PQueue({ concurrency: 1 });

			await Promise.all(
				wahleintraege.map(async (wahleintrag) => {
					// https://wahlen.digistadtdo.de/wahlergebnisse/Bundestagswahl2025/05913000/daten/api/wahl_35/wahl.json?ts=1741130017532

					const wahlUrl = `${apiEndpoint}/wahl_${wahleintrag.wahl.id}/wahl.json`;

					const { data: wahl } = await axiosWithRedirect<WahlDetails>(wahlUrl);

					const gemeindenEbenen = wahl.menu_links.filter((x) => x.title.toLowerCase().includes("gemeinden"));

					await Promise.allSettled(
						gemeindenEbenen.map(async (gemeindenEbene) => {
							try {
								var { data: gemeindenZweitstimmen } = await axiosWithRedirect<EbenenÜbersicht>(
									`${apiEndpoint}/wahl_${wahleintrag.wahl.id}/uebersicht_${gemeindenEbene.id}_1.json`
								);

								const gemeindenWithNoWahlbezirk = (gemeindenZweitstimmen.tabelle || []).zeilen.filter(
									(x) => !x.link && x.error === undefined && x.statusProzent === 100
								);

								try {
									await queue.addAll(
										gemeindenZweitstimmen.tabelle?.zeilen.map((x) => async () => {
											try {
												if (!x.link) return;
												if (!x.link.url) return;

												if (x.externeUrl) {
													var url = x.link.url;
												} else {
													var url = new URL(x.link.url, präsentationUrl).href.replace("/index.html", "/");
												}

												await getWahlbezirkVotemanager({
													url: url,
													name: x.label,
													bundesland: opts.bundesland,
													filter: opts.filter,
												});
											} catch (error) {
												console.error(x.label, "" + error);
												gemeindenWithNoWahlbezirk.push(x);
												return;

												// throw error;
											}
										})
									);
								} catch (error) {
									console.error("queue error", error);
								}

								if (gemeindenWithNoWahlbezirk.length) {
									console.error(
										"gemeindenWithNoWahlbezirk",
										gemeindenWithNoWahlbezirk.map((x) => x.label)
									);
									// gemeinde with no link
									var { data: gemeindenErststimmen } = await axiosWithRedirect<EbenenÜbersicht>(
										`${apiEndpoint}/wahl_${wahleintrag.wahl.id}/uebersicht_${gemeindenEbene.id}_0.json`
									);

									const mapErststimmen = new Map(gemeindenErststimmen.tabelle.zeilen.map((x) => [x.label, x]));

									gemeindenWithNoWahlbezirk.forEach((zweitstimmen) => {
										const { label } = zweitstimmen;

										const erststimmen = mapErststimmen.get(label);
										if (!erststimmen) throw new Error("Cant find erstimmen for: " + label + " " + apiEndpoint);

										const kreis = gemeinde.kreis_name || gemeinde.wahlkreis_name!;

										const subgemeinde =
											(zweitstimmen.link?.url ? getGemeindeByUrlOrNull(zweitstimmen.link.url) : undefined) ||
											getGemeinde(label, kreis);
										if (!subgemeinde) throw new Error("Cant identify gemeinde: " + label + " " + kreis);

										const subResults = defaultResult();

										Object.assign(subResults, subgemeinde);

										// skip gemeinde + stand
										gemeindenErststimmen.tabelle.headerAbs.slice(2).forEach((header, index) => {
											const label = header.labelKurz.toLowerCase();
											const val = Number(erststimmen.felder[index].absolut.replaceAll(".", "")) || 0;

											if (label === "wahlberechtigte") {
												subResults.anzahl_berechtigte = val;
											} else if (
												label === "wähler" ||
												label === "wähler*innen" ||
												label === "wähler/-innen" ||
												label === "wählende"
											) {
												subResults.anzahl_wähler = val;
											} else if (label === "gültig") {
												subResults.erststimmen.gültig = val;
											} else {
												subResults.erststimmen.parteien[header.labelKurz] = val;
											}
										});

										gemeindenZweitstimmen.tabelle.headerAbs.slice(2).forEach((header, index) => {
											const label = header.labelKurz.toLowerCase();
											const val = Number(zweitstimmen.felder[index].absolut.replaceAll(".", "")) || 0;

											if (label === "wahlberechtigte") {
												subResults.anzahl_berechtigte = val;
											} else if (
												label === "wähler" ||
												label === "wähler*innen" ||
												label === "wähler/-innen" ||
												label === "wählende"
											) {
												subResults.anzahl_wähler = val;
											} else if (label === "gültig") {
												subResults.zweitstimmen.gültig = val;
											} else {
												subResults.zweitstimmen.parteien[header.labelKurz] = val;
											}
										});

										subResults.wahlbezirk_id = subResults.gemeinde_id;
										subResults.wahlbezirk_name = subResults.gemeinde_name;

										if (subResults.wahlbezirk_name === "Altmittweida") {
											debugger;
										}

										results.push(subResults);
									});
								}
							} catch (error) {}
						})
					);

					if (wahlkreiseStadt.has(gemeinde.wahlkreis_id!)) {
						// stadtwahlbezirke können nicht immer eindeutig einem Stadtteil zugeordnet werden => OpenDataCSV

						const csv = await getVotemanagerOpenData(apiEndpoint, gemeinde);

						for (const csvResult of csv) {
							for (const x of csvResult) {
								if (x.wahlbezirk_name === "Altmittweida") {
									debugger;
								}
							}
							results.push(...csvResult);
						}

						return;
					}

					try {
						var { data: wahlbezirke } = await axiosWithRedirect<EbenenÜbersicht>(
							`${apiEndpoint}/wahl_${wahleintrag.wahl.id}/uebersicht_ebene_6_1.json`
						);
						if (!wahlbezirke.tabelle) throw new Error("Keine Wahlbezirke");
					} catch (error) {
						throw new Error("Keine BTW25 Ergebnisse (Keine Wahlbezirke) ");
					}

					var url = base + "/" + btw25.url;

					const openData = await getVotemanagerOpenData(url, gemeinde);

					await queue.addAll(
						wahlbezirke.tabelle.zeilen
							.filter((x) => !x.externeUrl && x.link?.id?.includes("ebene_6"))
							.map((x) => async () => {
								try {
									url =
										base +
										"/" +
										btw25.url +
										`ergebnis.html?wahl_id=${wahleintrag.wahl.id}&stimmentyp=${wahleintrag.stimmentyp.id}&id=${
											x.link!.id
										}`;

									const wahlbezirk_result = await votemanagerWithOptions({
										ebene_id: x.link!.id,
										wahl_id: `${wahleintrag.wahl.id}`,
										url: apiEndpoint,
										name: opts.name,
									});

									assignOptional(wahlbezirk_result, gemeinde);

									const id = x.link!.id.match(/ebene_6_id_(\d+)/)?.[1];
									if (!id) throw new Error("Invalid wahlbezirk id: " + x.link!.id);

									wahlbezirk_result.wahlbezirk_name = x.label;
									wahlbezirk_result.wahlbezirk_id = id;

									const wahlraum =
										wahlräumeNachBezirkName[x.label] || wahlräumeNachBezirkNr[wahlbezirk_result.wahlbezirk_id!];
									wahlbezirk_result.wahlbezirk_adresse = wahlraum?.wahlraumAdresse;

									if (wahlraum?.bezirkArt) {
										wahlbezirk_result.briefwahl = wahlraum.bezirkArt === "B" || wahlraum.bezirkArt === "Briefwahl";
									}
									wahlbezirk_result.wahlbezirk_raum = wahlraum?.wahlraumBezeichnung;

									if (wahlbezirk_result.wahlbezirk_name === "Altmittweida") {
										debugger;
									}

									results.push(wahlbezirk_result);
								} catch (error) {
									if ((error as Error).message.includes("Keine Daten")) {
										openData.find((data) => {
											const entry = data.find((y) => y.wahlbezirk_name === x.label);
											if (!entry) return;

											if (entry.wahlbezirk_name === "Altmittweida") {
												debugger;
											}

											results.push(entry);

											return true;
										});

										return;
									}

									throw new Error(
										"Error " + x.label + " " + url + " " + JSON.stringify(x) + " " + (error as Error).message
									);
								}
							})
					);

					let title = wahleintrag.gebiet_link.title;
					if (title === "Gesamtergebnis") title = data.title;
				})
			);

			await queue.onIdle();

			return results;
		} catch (error) {
			if ((error as Error).message.includes("Keine BTW25")) return results;

			var e = error;
			e;

			throw new Error("Error " + opts!.name + " " + opts!.url + " " + (error as Error).message);
		}
	})();

	promiseScraped.set(opts.url, promise);

	return promise;
}

const ParteienNamen = {
	"Christlich Demokratische Union Deutschlands": "CDU",
	"Sozialdemokratische Partei Deutschlands": "SPD",
	"BÜNDNIS 90/DIE GRÜNEN": "GRÜNE",
	"Freie Demokratische Partei": "FDP",
	"Alternative für Deutschland": "AfD",
	"Basisdemokratische Partei Deutschland": "dieBasis",
	"PARTEI MENSCH UMWELT TIERSCHUTZ": "Tierschutzpartei",
	"Partei für Arbeit, Rechtsstaat, Tierschutz, Elitenförderung und basisdemokratische Initiative": "Die PARTEI",
	"Volt Deutschland": "Volt",
	"Ökologisch-Demokratische Partei / Familie und Umwelt": "ÖDP",
	"Bündnis C - Christen für Deutschland": "Bündnis C",
	"Marxistisch-Leninistische Partei Deutschlands": "MLPD",
	"BÜNDNIS DEUTSCHLAND": "BÜNDNIS DEUTSCHLAND",
	"Bündnis Sahra Wagenknecht - Vernunft und Gerechtigkeit": "BSW",
} as Record<string, string>;

// not used because ags + gebietnr is not enough to uniquely identify a comune
async function getVotemanagerOpenData(url: string, oberGemeinde: ReturnType<typeof getGemeinde>) {
	url = url.replace("/api", "/").replace("/praesentation/", "/daten/");
	if (!url.endsWith("/")) url += "/";

	const base = new URL("opendata/", url).href;

	const { data: openData } = await axiosWithRedirect<OpenData>(`${base}/open_data.json`);

	const bezirke = openData.csvs.filter((x) => x.ebene.toLowerCase().includes("bezirke") && x.ebene !== "Stadtbezirke");
	if (!bezirke) throw new Error("Keine Wahlbezirke in OpenData");

	return Promise.all(
		bezirke.map(async (bezirk) => {
			const csvUrl = new URL(bezirk.url, base).href;

			const wahlkreis_id = bezirk.ebene.match(/Bezirke \(Wahlkreise: (\d+)\)/)?.[1];

			const csvText = await axiosWithRedirect(csvUrl, { responseType: "text" });
			const csv = await csvParse({ data: csvText.data, separator: ";" });

			const csvResults = [] as ResultType[];

			csv.forEach((x) => {
				const { datum, wahl, ags, "gebiet-nr": GebietNr, "gebiet-name": GebietName } = x as Record<string, string>;

				const wahlberechtigte = Number(x.A);
				const wähler = Number(x.B);
				const ungültigeErststimmen = Number(x.C);
				const gültigeErststimmen = Number(x.D);
				const ungültigeZweitstimmen = Number(x.E);
				const gültigeZweitstimmen = Number(x.F);

				const result = defaultResult();

				result.anzahl_berechtigte = wahlberechtigte;
				result.anzahl_wähler = wähler;
				result.erststimmen.gültig = gültigeErststimmen;
				result.erststimmen.ungültig = ungültigeErststimmen;
				result.zweitstimmen.gültig = gültigeZweitstimmen;
				result.zweitstimmen.ungültig = ungültigeZweitstimmen;

				assignOptional(result, oberGemeinde);
				if (wahlkreis_id) {
					result.wahlkreis_id = wahlkreis_id;
				}

				result.wahlbezirk_id = getIdFromName(GebietName) || null;
				result.wahlbezirk_name = GebietName;

				const { parteien } = openData.dateifelder.find((x) => x.parteien) || {};
				if (!parteien) return;

				parteien.forEach((partei) => {
					const [erststimmeFeld, zweitstimmeFeld] = partei.feld.split(" / ");

					const erststimmen = Number(x[erststimmeFeld]);
					const zweitstimmen = Number(x[zweitstimmeFeld]);

					const parteiName = ParteienNamen[partei.wert] || partei.wert;

					result.erststimmen.parteien[parteiName] = erststimmen;
					result.zweitstimmen.parteien[parteiName] = zweitstimmen;
				});

				csvResults.push(result);
			});

			return csvResults;
		})
	);
}

type Wahlraum = {
	ags: string;
	bezirkNr: string;
	bezirkName: string;
	bezirkArt: string;
	wahlraumBezeichnung: string;
	wahlraumAdresse: string;
	wahlraumBarrierefrei: string;
	wahlraumBarrierefreiErgaenzung: string;
};

async function getVotemanagerWahllokale(url: string, oberGemeinde: ReturnType<typeof getGemeinde>) {
	url = url.replace("/api", "/").replace("/praesentation/", "/daten/");
	if (!url.endsWith("/")) url += "/";

	const base = new URL("opendata/", url).href;

	const { data: csv } = await axiosWithRedirect<string>(`${base}/opendata-wahllokale.csv`, { responseType: "text" });
	const data: {
		datum: string;
		ags: string;
		"Bezirk-Nr": string;
		"Bezirk-Name": string;
		"Bezirk-Art": string;
		"Wahlraum-Bezeichnung": string;
		"Wahlraum-Adresse": string;
		"Wahlraum-Barrierefrei": string;
		"Wahlraum-Barrierefrei-Ergaenzung": string;
	}[] = await csvParse({ data: csv, separator: ";" });

	const wahlräume = data.map((x) => ({
		ags: x.ags,
		bezirkNr: x["Bezirk-Nr"],
		bezirkName: x["Bezirk-Name"],
		bezirkArt: x["Bezirk-Art"],
		wahlraumBezeichnung: x["Wahlraum-Bezeichnung"],
		wahlraumAdresse: x["Wahlraum-Adresse"],
		wahlraumBarrierefrei: x["Wahlraum-Barrierefrei"],
		wahlraumBarrierefreiErgaenzung: x["Wahlraum-Barrierefrei-Ergaenzung"],
	}));

	const wahlräumeNachBezirkNr = {} as Record<string, Wahlraum>;
	const wahlräumeNachBezirkName = {} as Record<string, Wahlraum>;

	wahlräume.forEach((x) => {
		wahlräumeNachBezirkNr[x.bezirkNr] = x;
		wahlräumeNachBezirkName[x.bezirkName] = x;
	});

	return {
		wahlräumeNachBezirkNr,
		wahlräumeNachBezirkName,
		wahlräume,
	};
}

export async function getWahlbezirkeVotemanager(bundeslandFilter?: string[], filter?: (opts: VotemanagerOpts) => boolean) {
	const {
		data: { data },
	} = await axiosWithRedirect("https://wahlen.votemanager.de/behoerden.json", { responseType: "json" });

	await Promise.all(
		data.map((x: string[]) => {
			const [link, name, bundesland] = x;
			if (bundeslandFilter && !bundeslandFilter.includes(bundesland)) return;
			if (name.startsWith("Land ")) return;

			let [url] = extractUrls(link) as string[];

			url = url.replace("/index.html", "/");

			return behoerden_queue.add(async () => {
				try {
					const bezirk_result = await getWahlbezirkVotemanager({
						url,
						name,
						bundesland,
						filter,
					});
					if (!bezirk_result) return;
				} catch (error) {
					const msg = (error as Error).message || "";
					if (isFinalError(error as Error, url, name)) return;

					var e = error;
					e;
					// throw new Error(url + " " + name + " " + msg);
				}
			});
		})
	);

	await behoerden_queue.onIdle();
	return results;
}

export async function getWahlbezirkeVotemanagerFromWahlkreise() {
	await behoerden_queue.addAll(
		Object.values(wahlkreiseQuellen).map((x) => async () => {
			try {
				if (!x.includes("praesentation/ergebnis.html?wahl_id")) return;

				const uri = new URL(x);
				uri.search = "";

				const base = uri.href.replace("/praesentation/ergebnis.html", "");

				const { data: config } = await axiosWithRedirect<VotemanagerConfig>(base + "/daten/api/config.json", {
					responseType: "json",
				});

				const alleWahltermine = new URL(config.alle_wahltermine_link, x);

				const result = await getWahlbezirkVotemanager({
					url: alleWahltermine.href,
					name: "",
					bundesland: "",
					onlySubgemeinden: true,
				});
				if (!result) return;
			} catch (error) {
				if ((error as Error).message.includes("Keine BTW25")) return;
				if ((error as Error).message.includes("Not votemanager")) return;

				throw error;
			}
		})
	);

	await behoerden_queue.onIdle();

	return results;
}

export interface Wahleintrag {
	wahl: {
		id: number;
		titel: string;
	};
	stimmentyp: {
		id: number;
		titel: string;
	};
	gebiet_link: {
		id: string;
		type: string;
		title: string;
	};
}

export interface WahlDetails {
	titel: string;
	datum: string;
	ergebnisstatus: any[];
	stimmentypen: {
		id: number;
		titel: string;
	}[];
	behoerden_links: {
		url: string;
		titel: string;
	}[];
	menu_links: {
		id: string;
		type: string;
		title: string;
	}[];
	geografik_ebenen: any[];
	hasHochrechnung: boolean;
	file_version: string;
	file_timestamp: string;
	server_hash: string;
}

export interface EbenenÜbersicht {
	zeitstempel: string;
	seitentitel: string;
	tabelle: {
		header: {
			labelKurz: string;
			labelLang?: string;
		}[];
		headerAbs: {
			labelKurz: string;
			labelLang?: string;
		}[];
		zeilen: {
			order_value: number;
			label: string;
			error?: any;
			link?: {
				id: string;
				type: string;
				title: string;
				url?: string;
			};
			externeUrl: boolean;
			statusString: string;
			statusProzent: number;
			stimmbezirk: boolean;
			highlighted: boolean;
			felder: {
				order_value_abs: string;
				order_value_proz: string;
				absolut: string;
				prozent: string;
				tip: string;
				highlighted: boolean;
			}[];
		}[];
	};
	has_geografik: boolean;
	file_version: string;
	file_timestamp: string;
	server_hash: string;
}

export interface WahlErgebnis {
	zeitstempel: string;
	seitentitel: string;
	Komponente: {
		hinweis_auszaehlung?: string;
		tabelle: {
			zeilen: {
				color: string;
				label: {
					labelKurz: string;
				};
				zahl: string;
				prozent: string;
				tagged: boolean;
			}[];
		};
		info: {
			titel: string;
			hinweis: any[];
			tabelle: {
				zeilen: {
					label: {
						labelKurz: string;
					};
					zahl: string;
					prozent: string;
					tagged: boolean;
				}[];
			};
		};
		grafik: {
			title: {
				titel: string;
				subtitle: string;
			};
			balken: {
				bezeichnung: string;
				color: string;
				bezeichnungAusfuehrlich: string;
				wert: number;
				wertString: string;
				prozentGerundet: number;
				prozentString: string;
			}[];
			sonstige: {
				bezeichnung: string;
				color: string;
				wert: number;
				wertString: string;
				prozentGerundet: number;
				prozentString: string;
			};
			sonstigeBalken: {
				bezeichnung: string;
				color: string;
				bezeichnungAusfuehrlich: string;
				wert: number;
				wertString: string;
				prozentGerundet: number;
				prozentString: string;
			}[];
			footer: string;
			isBalkenDarstellung: boolean;
			file_version: string;
			file_timestamp: string;
			server_hash: string;
		};
		wahlbeteiligung: {
			text: {
				text: string;
				prozent: number;
			};
			hinweis: string;
		};
		gebietsverlinkung?: {
			titel: string;
			gebietslinks?: {
				id: string;
				title: string;
				type: string;
			}[];
		}[];
	};
	file_version: string;
	file_timestamp: string;
	server_hash: string;
}

export interface OpenData {
	wahllokal_felder: any[];
	strassen_felder: any[];
	csvs: {
		wahl: string;
		ebene: string;
		url: string;
	}[];
	ergebnisgrafiken: any[];
	dateifelder: {
		name: string;
		felder: {
			feld: string;
			wert: string;
		}[];
		parteien: {
			feld: string;
			wert: string;
		}[];
	}[];
	file_version: string;
	file_timestamp: string;
	server_hash: string;
}

export interface Wahlraeume {
	headers: string[];
	wahlraeume: {
		titel: string;
		id: number;
		barrierefrei?: string;
		barrierefrei_ergaenzung?: string;
		bezirke: string[];
	}[];
	file_version: string;
	file_timestamp: string;
	server_hash: string;
}
