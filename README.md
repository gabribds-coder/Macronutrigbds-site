# MacroNutri GBDS

App web (PWA, funciona offline e pode ser instalado no celular) para:

- **Ciclo de proteína isocalórico**: calorias fixas; proteína, gordura e carboidrato variam por fase (a cada 1–7 dias).
- **Água diária dinâmica** conforme a fase do ciclo, treino e intestino.
- **Fibra diária** (14 g/1000 kcal) ajustada pela escala de Bristol.
- **Diário alimentar livre**: base TACO/USDA + alimentos personalizados.
- **Leitor de código de barras** pela câmera: busca o produto na base gratuita Open Food Facts e preenche os valores; produtos salvos são reconhecidos na hora nas próximas leituras.
- **Peso diário com tendência**, % de gordura, massa magra × massa gorda.
- **Gasto calórico adaptativo** (estilo MacroFactor) após ~3 semanas de registros.

Os dados ficam salvos no próprio aparelho (exportar/importar backup em *Perfil*).

## Como usar
Abra `index.html` por um servidor (ex.: GitHub Pages ou `python3 -m http.server`).
No celular: abra o site → menu do navegador → "Adicionar à tela inicial".

Embasamento científico: veja [ANALISE.md](ANALISE.md).

## Terceiros
- Leitura de código de barras: [ZXing](https://github.com/zxing-js/library) (Apache 2.0), em `js/vendor/`. Em celulares Android com suporte, usa o leitor nativo do navegador.
- Dados de produtos: [Open Food Facts](https://world.openfoodfacts.org) (ODbL), base colaborativa — confira sempre com o rótulo.
