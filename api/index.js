import express from "express";
import cookieParser from "cookie-parser";
import { bad } from "../lib/core.js";
import { router as authRouter } from "../lib/auth.js";
import { router as ticketsRouter } from "../lib/tickets.js";
import { router as groupsRouter } from "../lib/groups.js";
import { router as logsRouter } from "../lib/logs.js";

const app = express();
app.set("trust proxy", 1);
app.use(express.json());
app.use(cookieParser());

app.use("/api", authRouter);
app.use("/api", ticketsRouter);
app.use("/api", groupsRouter);
app.use("/api", logsRouter);

app.use("/api", (req, res) => bad(res, "Bulunamadı.", 404));
app.use((e, req, res, next) => {
  console.error(e);
  res.status(500).json({ error: "Sunucu hatası. Tekrar dene." });
});

export default app;
