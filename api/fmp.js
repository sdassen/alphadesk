export default async function handler(req, res) {
  const FMP_KEY = "Fs4tEUlKjGXH8TKQO32olCKH9w8gBIgG";
  const { path, ...params } = req.query;

  if (!path) {
    return res.status(400).json({ error: "Missing path" });
  }

  const searchParams = new URLSearchParams({ ...params, apikey: FMP_KEY });
  const url = `https://financialmodelingprep.com/api/v3/${path}?${searchParams}`;

  try {
    const response = await fetch(url);
    const data = await response.json();
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "s-maxage=300"); // cache 5 min
    return res.status(200).json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
