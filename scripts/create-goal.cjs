const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync("C:/Users/junin/second-brain/data/brain.db");
db.prepare(`
  INSERT INTO goals (id, name, description, type, status, priority, project, metric_name, target, current_value)
  VALUES ('goal.sales.gerar-caixa-sites', 'Gerar caixa através de venda de sites', 'Objetivo comercial da CONSECOM', 'SALES', 'ACTIVE', 1, 'project.vyntra', 'clientes', 10, 2)
  ON CONFLICT(id) DO NOTHING
`).run();
console.log(JSON.stringify(db.prepare("SELECT id, name, status FROM goals WHERE id='goal.sales.gerar-caixa-sites'").get()));
db.close();
