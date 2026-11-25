# CYL Audio Hub — documentação técnica

Versão 3.1.0, branch `cyl-audio-hub`. Pontos de recuperação:
- `baseline-pre-integracao`: Battery Hub traduzido, antes da integração;
- `pre-refinamento`: versão 3.0.0, antes desta etapa.

Visão geral para usuários: [README](../README.md).

## Arquitetura

| Módulo | Arquivo | Papel |
|---|---|---|
| Core | `src/main/main.js` | Ciclo de vida, instância única, janela, bandeja, inicialização com o Windows, suspensão e retomada |
| Device Manager | `src/main/hid/*`, `src/main/system-batteries.cs` | Leitura de bateria do Battery Hub num worker `utilityProcess` |
| Diagnóstico | `src/main/devdiag.js`, `src/main/hid/passive.js` | Diagnóstico por periférico, relatório local e escuta passiva somente leitura |
| Audio Manager | `src/main/audio/manager.js`, `engine.js` | Dispositivos, volume, mudo e padrão do Windows via `native/AudioEngine.exe` (WASAPI), num único processo persistente |
| Equalizador | `src/main/audio/apo.js` | Arquivo próprio do Equalizer APO, linha `Include:`, backup, escrita atômica e remoção reversível |
| Perfis | `src/main/audio/model.js`, `autoswitch.js` | 5 perfis iniciais, gerenciamento, importação/exportação e troca automática opcional por programa |
| Binds | `src/main/keybinds/*` | Atalhos globais via `RegisterHotKey` |
| Integração | `src/main/cyl.js` | IPC validado, menu da bandeja e ações |
| UI | `src/renderer/cyl.js`, `index.html`, `styles.css` | Visão geral, Dispositivos, Equalizador, Microfone, Perfis, Binds e Configurações |
| Marca | `scripts/build-brand.js` | Ícones e imagens gerados a partir de `src/imgs` |

**Segurança:**
- `contextIsolation` ativo, sem `nodeIntegration` e um canal IPC por operação. Os IDs de dispositivo são conferidos com a lista real do Windows.
- Arquivos só são lidos ou gravados por diálogos que o usuário respondeu.
- Só a janela do app pode usar o microfone. A câmera e as demais permissões são negadas.
- **O app não acessa a internet.** Desde a 3.1.0 o diagnóstico herdado do Battery Hub também não consulta mais a API do GitHub do projeto original.

## Correções desta etapa (3.1.0)

**Leitura de bateria**
- Leitura antiga ou de dispositivo desligado deixou de ser mostrada como atual. Ela vira "sem leitura atual", e a última carga conhecida aparece separada, como histórico.
- A Visão geral mostra a fonte ("Leitura real") e a idade de cada leitura.
- Novo diagnóstico por periférico em **Dispositivos › Diagnóstico**, com relatório técnico que pode ser copiado ou exportado.
- O H510-PRO (`040B:0897`) nunca recebe os "pings" de saída da varredura de calibração herdada do Battery Hub. Antes, essa varredura enviava relatórios zerados a qualquer dispositivo, quando acionada manualmente.

**Rede**
- O diagnóstico herdado ficou offline.
- Os links de relatório apontam para `cellixx7/Cyl_Hub`, não para o Battery Hub original.

**Equalizer APO**
- O app reconhece o `DeviceSelector.exe` (nome do Configurator a partir do APO 1.4).
- Escrita resistente à corrida com o serviço de áudio. Logo depois de uma gravação, o APO abre o arquivo para recarregá-lo, e o `rename` falhava com EPERM. Agora a escrita tenta de novo e, se o arquivo continuar preso, grava no lugar.

**Identidade visual**
- Ícones do app, do instalador, da bandeja e das notificações, e arte da interface, todos gerados a partir de `src/imgs`.
- Paleta CYL e foco de teclado visível.
- A arte antiga do Battery Hub foi retirada do pacote.

## Diagnóstico dos dispositivos (feito neste PC)

### Redragon Zeus Pro H510-PRO (receptor 2.4 GHz)

- **Fabricante, produto e ID:** XiiSound Technology Corporation, "H510-PRO Wireless headset", USB `040B:0897`.
- **Áudio:** "Fones de ouvido (H510-PRO Wireless headset)", ID `{edfab09e-1c1f-4a35-aabf-46cf37ac7d44}`, e "Microfone (H510-PRO Wireless headset)", ambos com driver `usbaudio`.
- **Interfaces HID (interface 3):**
  - `0xF100`, do fabricante: relatório de entrada de 12 bytes e de saída de 64 bytes, sem relatórios de feature;
  - `0x000C`/`0x000B`: teclas de mídia e de telefonia.

| Pergunta investigada | Resultado |
|---|---|
| O Windows expõe a bateria? | Não. A propriedade de bateria do dispositivo (`{104EA319-…} 2`) está vazia em todas as interfaces. |
| Existe relatório HID padrão de bateria (página 0x85 ou 0x84)? | Não. |
| O receptor transmite a carga sozinho? | Não. Nada em 30 s de escuta (etapa anterior) e 0 quadros em 4 s e 8 s de escuta passiva no autoteste. |
| O Zeus Pro Suite tinha algo aproveitável? | Só uma estimativa por tempo de uso. Ela não foi trazida, porque não é leitura. |
| Projetos públicos implementam o protocolo? | Não. O HeadsetControl não suporta esse ID. Há um pedido aberto, [Wireless-Device-Battery-Monitor #160](https://github.com/krisgfx9/Wireless-Device-Battery-Monitor/issues/160), com a mesma conclusão sobre esse chip XiiSound/Weltrend: sem protocolo público. |
| A consulta estava na interface certa? | Sim. A única interface proprietária é a `0xF100`. |

**Conclusão: bateria Indisponível.** Para obter a leitura seria preciso descobrir o comando por engenharia reversa, capturando o tráfego USB do software oficial. Isso está fora do escopo seguro definido e não foi feito.

### Mouse sem fio

- **Receptor:** USB `1D57:FA60` (Xenta/Beken), que se identifica como "LXDDZ 2.4G Wireless Device". O modelo comercial exato não aparece nos descritores USB.
- **Interfaces HID:**
  - mouse na interface 1, página `0x01/0x02`;
  - na interface 2, controle do sistema, mídia e duas coleções do fabricante, nas páginas `0x0A` e `0x0B`;
  - teclado na interface 3.
- **Bateria: leitura real.** O receptor transmite sozinho, a cada ~2 s, o quadro `03 55 40 <estado> <nível>`. Isso foi verificado capturando `03 55 40 01 5f`, que significa em bateria, 0x5F = 95%. O driver `beken` do Battery Hub já interpretava esse quadro corretamente. Nada é enviado ao mouse.
- **Problemas verificados e descartados:** enumeração, VID/PID, interface (canal `0x0A`), acesso compartilhado e interpretação dos dados.

**O que realmente estava errado:**
- uma leitura antiga ou de dispositivo desligado era exibida como se fosse atual;
- não havia diagnóstico que explicasse a origem da leitura.

Ambos foram corrigidos nesta versão.

### Outros dispositivos

- **"AE01" (Bluetooth, ID `05D6:000A`):** a bateria vem do Windows e é uma leitura real quando ele está ligado. Nos testes ele estava desligado, e o app mostra "sem leitura atual" com a última carga como histórico.
- **Teclado USB `1A2C:45EA`, com fio:** não tem bateria e fica fora da lista.

## Equalizer APO

**Instalação (24/11/2026, com sua autorização)**
- Versão 1.4.2, `EqualizerAPO-x64-1.4.2.exe`, baixada do SourceForge oficial.
- O SHA-256 `7403be7427bbe1936a40dded082829b6e217fc4f5990fee5cba501f0ae055afa` confere com o `checksum64` publicado no pacote Chocolatey 1.4.2, uma fonte independente. O instalador não tem assinatura digital, como é usual nesse projeto.
- O APO foi instalado **só** na saída do H510-PRO; nenhum outro endpoint foi alterado. O instalador guardou o backup `backup_H510-PRO Wireless headset_Fones de ouvido.reg` na pasta do APO.
- Antes disso, as chaves de áudio do registro (`MMDevices\Audio\Render` e `Capture`) foram exportadas para `%APPDATA%\CYL Audio Hub\apo-backups\`.
- O `config.txt` padrão do instalador trazia preamp de -6 dB e um reforço de graves de exemplo. Essas linhas foram desativadas com `# [CYL desativado]` (com backup) para não se somarem ao perfil do CYL.
- O serviço "Áudio do Windows" foi reiniciado. O PC não precisou ser reiniciado.

**Validação do processamento real.** Gravar o arquivo de configuração não basta para provar que o som foi processado. Por isso:
- um programa de teste toca um tom de 1 kHz a -35 dBFS na saída do H510;
- ao mesmo tempo, mede essa saída por loopback do WASAPI, ou seja, o que sai do motor de áudio depois dos efeitos;
- a medição usa Goertzel em 1 kHz, que mede só essa frequência e por isso ignora outros sons tocando no PC.

As configurações foram aplicadas pelo próprio módulo `apo.js` do app.

| Configuração | Esperado em 1 kHz | Medido |
|---|---|---|
| EQ plano | 0 dB | −0,31 dB |
| Preamp −12 dB | −12 dB | −11,43 dB |
| Banda 1 kHz +6 dB com preamp −6 dB | 0 dB | +0,18 dB |
| Perfil Valorant — Competitivo (preamp −3,5, +0,5 em 1 kHz) | −3,0 dB | −2,91 dB |
| EQ desligado (com o perfil Valorant ativo) | 0 dB | +0,04 dB |

**Conclusão: o equalizador do CYL processa o áudio do H510-PRO de verdade.** A ativação e desativação, a troca de perfis e o preamp foram confirmados pela medição. A persistência das configurações é coberta pelos testes. A conexão é a de 2.4 GHz, porque o endpoint é o do receptor.

**Áudio espacial e clipping**
- A curva do CYL é um EQ estéreo, sem surround virtual. O HRTF do Valorant não é duplicado.
- Recomendação: deixe o "Som espacial" do Windows desligado no H510 e escolha o áudio espacial só dentro do jogo.
- Atenção: há dispositivos virtuais do **SteelSeries Sonar** instalados neste PC. Se um jogo enviar o som para "SteelSeries Sonar - Gaming", o EQ do Sonar e o do CYL se somam. Hoje a saída padrão do Windows é o H510 direto.
- O app sugere um preamp negativo quando há ganho positivo nas bandas (risco de clipping). Os perfis iniciais já vêm com preamp seguro.

**Filtros de microfone:** o APO não foi instalado no microfone. Os filtros de passa-altas e presença do perfil Discord só passam a valer se você marcar o microfone no Device Selector.

## Desempenho

Medido em 24/11/2026 com `npm run bench`, no modo de desenvolvimento, num Ryzen 5 5600GT com Windows 10 22H2. A soma inclui todos os processos do app. Cada janela de medição durou 64 s.

| Cenário | Processos | Memória privada | Working set | CPU média |
|---|---|---|---|---|
| Battery Hub original, janela aberta | 6 | 197,8 MB | 462,2 MB | 0,014 % |
| 3.0.0, janela aberta | 7 | 180,6 MB | 385,7 MB | 0,058 % |
| 3.0.0, em segundo plano | 5 | 132,7 MB | 236,8 MB | 0,004 % |
| **3.1.0, janela aberta** (APO ativo, baterias monitoradas) | 7 | **178,8 MB** | 386,5 MB | **0,074 %** |
| **3.1.0, em segundo plano** | 5 | **120,7 MB** | 232,4 MB | **0,002 %** |

**Tempos**
- Janela pronta em cerca de 1,2 s após o início do processo.
- Em segundo plano, 16 ms de CPU em 64 s.

**Como fica sem janela**
- Nada é desenhado.
- Os timers da interface param quando a página não está visível.
- O motor de áudio encerra após 45 s ocioso.
- O mouse é lido pela escuta das transmissões, a cada 60 s (configurável).
- Os binds não custam nada enquanto ninguém os pressiona.

**Meta de < 100 MB em segundo plano: não atingida.** O piso do Electron são os processos principal, de GPU e de rede, cerca de 160 MB de working set somados. A isso se somam o worker HID (~57 MB) e o leitor do Windows (16 MB). Trocar o runtime (Tauri ou nativo) não foi feito, como pedido.

**Impacto em FPS no Valorant: não medido.** Eu não tenho como rodar o jogo. Procedimento recomendado, com CapFrameX ou PresentMon:
1. Faça 3 capturas de 60 s num cenário repetível com o app fechado.
2. Faça mais 3 com ele em segundo plano, perfil Valorant e APO ativos.
3. Compare média e 1 % low.

## Testes

**Testes automatizados:** `npm test` roda 251 testes unitários, todos passando. Eles cobrem:
- perfis, renderização e arquivos do APO (em pasta temporária);
- Audio Manager e cliente do motor de áudio, inclusive com o `AudioEngine.exe` real;
- validação dos binds e notificações;
- diagnóstico de dispositivos: leitura real, antiga ou desligada, H510 indisponível e relatório sem dados sensíveis;
- garantia de que a escuta passiva nunca escreve;
- gerador de ícones (recorte, PNG, ICO) e assets gerados.

**Autoteste no app real com o hardware deste PC** (`CYL_SELFTEST=1`): **28/28**. Ele verifica:
- **Headset:** os endpoints do H510, o receptor HID e a bateria "Indisponível".
- **Mouse:** o receptor do mouse, a leitura real (95 %, driver `beken`), a escuta passiva que ouve o mouse e a escuta passiva do H510, que não recebe nada e não escreve nada.
- **Áudio:** mudo do microfone (restaurado depois), gravação de volume, troca de perfil, estado do APO e liga/desliga do EQ.
- **Binds:** registro no Windows e disparo por tecla real (SendInput), também com a janela fechada na bandeja. Uma combinação ocupada por outro processo é recusada sem afetar as demais.
- **Suspensão e retomada:** com eventos simulados. Uma suspensão real da máquina não foi feita.
- **Janela:** a janela oculta é liberada da memória e reaberta.
- **Permissões:** microfone permitido, câmera negada.

**Medição física do EQ:** a tabela acima, feita em hardware real.

**Verificados manualmente:**
- instância única;
- capturas de todas as páginas nos temas escuro e claro;
- migração das configurações;
- item de inicialização.

**Não verificados fisicamente:**
- reconexão do receptor (exige tirar e recolocar o dongle);
- suspensão real do Windows;
- sessão longa de microfone (horas);
- desinstalação.

Os caminhos de código desses casos estão cobertos por testes ou pelo autoteste com eventos simulados.

## Limitações e próximos passos

- **Bateria do H510-PRO:** só seria possível com o protocolo do fabricante (ver acima). O próximo passo seguro seria uma captura de USB (USBPcap) feita por você enquanto o software oficial da Redragon mostra a bateria, para documentar o comando.
- **Ícone de 16 px:** em 16 px a ilustração perde detalhe. Um ícone desenhado para esse tamanho (só o rosto, contorno grosso) melhoraria a bandeja.
- **Filtros de microfone:** marque o microfone do H510 no Device Selector se quiser os filtros do perfil Discord.
- **Instalador:** não tem assinatura digital, e o SmartScreen pode avisar.
- **Idioma:** as páginas novas estão só em PT-BR.
